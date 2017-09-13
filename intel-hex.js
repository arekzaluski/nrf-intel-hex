'use strict';

/**
 * Parser/writer for the "Intel hex" format.
 *
 * @module nrf-intel-hex
 */

/*
 * A regexp that matches lines in a .hex file.
 *
 * One hexadecimal character is matched by "[0-9A-Fa-f]".
 * Two hex characters are matched by "[0-9A-Fa-f]{2}"
 * Eight or more hex characters are matched by "[0-9A-Fa-f]{8,}"
 * A capture group of two hex characters is "([0-9A-Fa-f]{2})"
 *
 * Record mark         :
 * 8 or more hex chars  ([0-9A-Fa-f]{8,})
 * Checksum                              ([0-9A-Fa-f]{2})
 * Optional newline                                      (?:\r\n|\r|\n)?
 */
const hexLineRegexp = /:([0-9A-Fa-f]{8,})([0-9A-Fa-f]{2})(?:\r\n|\r|\n|)/g;


// Takes a Uint8Array as input,
// Returns an integer in the 0-255 range.
function checksum(bytes) {
    return (-bytes.reduce((sum, v)=>sum + v, 0)) & 0xFF;
}

// Takes two Uint8Arrays as input,
// Returns an integer in the 0-255 range.
function checksumTwo(array1, array2) {
    let partial1 = array1.reduce((sum, v)=>sum + v, 0);
    let partial2 = array2.reduce((sum, v)=>sum + v, 0);
    return -( partial1 + partial2 ) & 0xFF;
}

/**
 * Given a {@link https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Map|<tt>Map</tt>}
 * of <tt>id</tt> to <tt>Map</tt>s of address to
 * {@link https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array|<tt>Uint8Array</tt>}s,
 * returns a <tt>Map</tt> of address to tuples (<tt>Arrays</tt>s of length 2) of the form
 * <tt>(id, Uint8Array)</tt>s.
 *<br/>
 * The scenario for using this is having several sets of memory blocks, from several calls to
 * {@link module:nrf-intel-hex~hexToArrays|hexToArrays}, each having a different identifier.
 * This function locates where those memory block sets overlap, and returns a <tt>Map</tt>
 * containing addresses as keys, and arrays as values. Each array will contain 1 or more
 * <tt>(id, Uint8Array)</tt> tuples: the identifier of the memory block set that has
 * data in that region, and the data itself. When memory block sets overlap, there will
 * be more than one tuple.
 *<br/>
 * The <tt>Uint8Array</tt>s in the output are
 * {@link https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/TypedArray/subarray|subarrays}
 * of the input data.
 *<br/>
 * The insertion order of keys in the output <tt>Map</tt> is guaranteed to be strictly
 * ascending. In other words, when iterating through the <tt>Map</tt>, the addresses
 * will be ordered in ascending order.
 *<br/>
 * When two blocks overlap, the corresponding array of tuples will have the tuples ordered
 * in the insertion order of the input <tt>Map</tt> of block sets.
 *<br/>
 *
 * @param {Map.Map.Uint8Array} The input memory block sets
 *
 * @example
 * import { overlapBlockSets, hexToArrays } from 'nrf-intel-hex';
 *
 * let blocks1 = hexToArrays( hexdata1 );
 * let blocks2 = hexToArrays( hexdata2 );
 * let blocks3 = hexToArrays( hexdata3 );
 *
 * let blockSets = new Map([
 *  ['blocks A', blocks1],
 *  ['blocks B', blocks2],
 *  ['blocks C', blocks3]
 * ]);
 *
 * let overlappings = overlapBlockSets(blockSets);
 *
 * for (let [address, tuples] of overlappings) {
 *     // if 'tuples' has length > 1, there is an overlap starting at 'address'
 *
 *     for (let [address, tuples] of overlappings) {
 *         let [id, bytes] = tuple;
 *         // 'id' in this example is either 'blocks A', 'blocks B' or 'blocks C'
 *     }
 * }
 * @return {Map.Array<mixed,Uint8Array>} The map of possibly overlapping memory blocks
 */
function overlapBlockSets(blockSets) {

    // First pass: create a list of addresses where any block starts or ends.
    let cuts = new Set();
    for (let [setId, blocks] of blockSets) {
        for (let [address, block] of blocks) {
            cuts.add(address);
            cuts.add(address + block.length);
        }
    }

    let orderedCuts = Array.from(cuts.values()).sort((a,b)=>a-b);
    let overlaps = new Map();

    // Second pass: iterate through the cuts, get slices of every intersecting blockset
    for (let i=0, l=orderedCuts.length-1; i<l; i++) {
        let cut = orderedCuts[i];
        let nextCut = orderedCuts[i+1];
        let tuples = [];

        for (let [setId, blocks] of blockSets) {
            // Find the block with the highest address that is equal or lower to
            // the current cut (if any)
            let blockAddr = Array.from(blocks.keys()).reduce((acc, val)=>{
                if (val > cut) {
                    return acc;
                }
                return Math.max( acc, val );
            }, -1);

            if (blockAddr !== -1) {
                let block = blocks.get(blockAddr);
                let subBlockStart = cut - blockAddr;
                let subBlockEnd = nextCut - blockAddr;

                if (subBlockStart < block.length) {
                    tuples.push([ setId, block.subarray(subBlockStart, subBlockEnd) ]);
                }
            }
        }

        if (tuples.length) {
            overlaps.set(cut, tuples);
        }
    }

    return overlaps;
}


/**
 * Given the output of the {@link module:nrf-intel-hex~overlapBlockSets|overlapBlockSets}
 * (a <tt>Map</tt> of address to an <tt>Array</tt> of <tt>(id, Uint8Array)</tt> tuples),
 * returns a {@link https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Map|<tt>Map</tt>}
 * of address to {@link https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array|<tt>Uint8Array</tt>}s.
 *<br/>
 * The output <tt>Map</tt> contains as many entries as the input one (using the same addresses
 * as keys), but the value for each entry will be the <tt>Uint8Array</tt> of the <b>last</b>
 * tuple for each address in the input data.
 *<br/>
 * The scenario is wanting to join together several parsed .hex files, not worrying about
 * their overlaps.
 *<br/>
 *
 * @param {Map.Array<mixed,Uint8Array>} overlaps The (possibly overlapping) input memory blocks
 * @return {Map.Uint8Array} The flattened memory blocks
 */
function flattenOverlaps(overlaps) {
    return new Map(
        Array.from(overlaps.entries()).map(([address, tuples]) => {
            return [address, tuples[tuples.length - 1][1] ];
        })
    );
}



/**
 * Takes a {@link https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Map|<tt>Map</tt>}
 * of address to {@link https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array|<tt>Uint8Array</tt>}s
 * as an input, and returns another <tt>Map</tt> of address to <tt>Uint8Array</tt>s, where:
 *
 * <ul>
 *  <li>Each address is a multiple of <tt>pageSize</tt></li>
 *  <li>The size of each <tt>Uint8Array</tt> is exactly <tt>pageSize</tt></li>
 *  <li>Bytes from the input map to bytes in the output</li>
 *  <li>Bytes not in the input are replaced by a padding value</li>
 *  <li>If the optional start and end parameters are used, only bytes
 *  between those addresses will be in the output.</li>
 * </ul>
 *<br/>
 * The scenario is wanting to prepare pages of bytes for a write operation, where the write
 * operation affects a whole page/sector at once.
 *<br/>
 * The insertion order of keys in the output <tt>Map</tt> is guaranteed to be strictly
 * ascending. In other words, when iterating through the <tt>Map</tt>, the addresses
 * will be ordered in ascending order.
 *<br/>
 * The <tt>Uint8Array</tt> in the output will be newly allocated.
 *<br/>
 *
 * @param {Map.Uint8Array} blocks The input memory blocks
 * @param {Number} [pageSize=1024] The size of the output pages
 * @param {Number} [pad=0xFF] The byte value to use for padding
// * @param {Number} [start=-Infinity] The size of the output pages
// * @param {Number} [end=Infinity] The size of the output pages
 * @return {Map.Uint8Array} The output page-sized memory blocks
 */
function paginate(blocks, pageSize=1024, pad=0xFF/*, start=-Infinity, end=Infinity*/) {
    if (pageSize <= 0) {
        throw new Error('Page size must be greater than zero');
    }
//     let pageAddr = -Infinity;
    let outPages = new Map();
    let page;

    let sortedKeys = Array.from(blocks.keys()).sort((a,b)=>a-b);

    for (let i=0,l=sortedKeys.length; i<l; i++) {
        const blockAddr = sortedKeys[i];
        const block = blocks.get(blockAddr);
        const blockLength = block.length;
        const blockEnd = blockAddr + blockLength;

        for (let pageAddr = blockAddr - (blockAddr % pageSize); pageAddr < blockEnd; pageAddr += pageSize) {
            page = outPages.get(pageAddr);
            if (!page) {
                page = new Uint8Array(pageSize);
                page.fill(pad);
                outPages.set(pageAddr, page);
            }

            const offset = pageAddr - blockAddr;
            let subBlock;
            if (offset <= 0) {
                // First page which intersects the block
                subBlock = block.subarray(0, Math.min(pageSize + offset, blockLength));
                page.set(subBlock, -offset);
            } else {
                // Any other page which intersects the block
                subBlock = block.subarray(offset, offset + Math.min(pageSize, blockLength - offset));
                page.set(subBlock, 0);
            }
        }
    }

    return outPages;
}






/**
 * Given a {@link https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Map|<tt>Map</tt>}
 * of {@link https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array|<tt>Uint8Array</tt>}s,
 * returns a new <tt>Map</tt> of <tt>Uint8Array</tt>s, concatenating together
 * those memory blocks that are adjacent.
 *<br/>
 * The insertion order of keys in the <tt>Map</tt> is guaranteed to be strictly
 * ascending. In other words, when iterating through the <tt>Map</tt>, the addresses
 * will be ordered in ascending order.
 *<br/>
 * If <tt>maxBlockSize</tt> is given, blocks will be concatenated together only
 * until the joined block reaches this size in bytes. This means that the output
 * <tt>Map</tt> might have more entries than the input one.
 *<br/>
 * If there is any overlap between blocks, an error will be thrown.
 *
 * @param {Map.Uint8Array} blocks The input memory blocks
 * @param {Number} [maxBlockSize=Infinity] Maximum size of the returned <tt>Uint8Array</tt>s.
 *
 * @return {Map.Uint8Array} The joined memory blocks
 */
function joinBlocks(blocks, maxBlockSize = Infinity) {

    // First pass, create a Map of address→length of contiguous blocks
    let sortedKeys = Array.from(blocks.keys()).sort((a,b)=>a-b);
    let blockSizes = new Map();
    let lastBlockAddr = -1;
    let lastBlockEndAddr = -1;

    for (let i=0,l=sortedKeys.length; i<l; i++) {
        const blockAddr = sortedKeys[i];
        const blockLength = blocks.get(sortedKeys[i]).length;

        if (lastBlockEndAddr === blockAddr && (lastBlockEndAddr - lastBlockAddr) < maxBlockSize) {
            // Grow when the previous end address equals the current,
            // and we don't go over the maximum block size.
            blockSizes.set(lastBlockAddr, blockSizes.get(lastBlockAddr) + blockLength);
            lastBlockEndAddr += blockLength;
        } else if (lastBlockEndAddr <= blockAddr) {
            // Else mark a new block.
            blockSizes.set(blockAddr, blockLength);
            lastBlockAddr = blockAddr;
            lastBlockEndAddr = blockAddr + blockLength;
        } else {
            throw new Error('Overlapping data around address 0x' + blockAddr.toString(16));
        }
    }

    // Second pass: allocate memory for the contiguous blocks and copy data around.
    let mergedBlocks = new Map();
    let mergingBlock;
    let mergingBlockAddr = -1;
    for (let i=0,l=sortedKeys.length; i<l; i++) {
        const blockAddr = sortedKeys[i];
        if (blockSizes.has(blockAddr)) {
            mergingBlock = new Uint8Array(blockSizes.get(blockAddr));
            mergedBlocks.set(blockAddr, mergingBlock);
            mergingBlockAddr = blockAddr;
        }
        mergingBlock.set(blocks.get(blockAddr), blockAddr - mergingBlockAddr);
    };

    return mergedBlocks;
}


/**
 * Parses a string containing data formatted in "Intel HEX" format, and
 * returns a {@link https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Map|<tt>Map</tt>}
 * of {@link https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array|<tt>Uint8Array</tt>}s.
 * In every entry of the <tt>Map</tt>, the key is the starting address of
 * a data block, and the value is the <tt>Uint8Array</tt> with the data for
 * that block.
 *<br/>
 * A .hex file can contain a single block of contiguous binary data starting at
 * memory address 0 (and it's the common case for simple .hex files), but complex files
 * with several non-contiguous data blocks are also possible, thus the need for
 * a data structure on top of the <tt>Uint8Array</tt>s.
 *<br/>
 * The insertion order of keys in the <tt>Map</tt> is guaranteed to be strictly
 * ascending. In other words, when iterating through the <tt>Map</tt>, the addresses
 * will be ordered in ascending order.
 *<br/>
 * The parser has an opinionated behaviour, and will throw a descriptive error if it
 * encounters some malformed input. Check the project's
 * {@link https://github.com/NordicSemiconductor/nrf-intel-hex#Features|README file} for details.
 *<br/>
 * If <tt>maxBlockSize</tt> is given, any contiguous data block larger than that will
 * be split in several blocks.
 *
 * @param {String} hexText The contents of a .hex file.
 * @param {Number} [maxBlockSize=Infinity] Maximum size of the returned <tt>Uint8Array</tt>s.
 *
 * @return {Map.Uint8Array}
 *
 * @example
 * import { hexToArrays } from 'nrf-intel-hex';
 *
 * let intelHexString =
 *     ":100000000102030405060708090A0B0C0D0E0F1068\n" +
 *     ":00000001FF";
 *
 * let byteArrays = hexToArrays(intelHexString);
 *
 * for (let [address, dataBlock] of byteArrays) {
 *     console.log('Data block at ', address, ', bytes: ', dataBlock);
 * }
 */
function hexToArrays(hexText, maxBlockSize = Infinity) {
    let blocks = new Map();

    let lastCharacterParsed = 0;
    let matchResult;
    let recordCount = 0;

    // Upper Linear Base Address, the 16 most significant bits (1 bytes) of
    // the current 32-bit (4-byte) address
    // In practice this is a offset that is summed to the "load offset" of the
    // data records
    let ulba = 0;

    hexLineRegexp.lastIndex = 0; // Reset the regexp, if not it would skip content when called twice

    while ((matchResult = hexLineRegexp.exec(hexText)) !== null) {
        recordCount++;

        // By default, a regexp loop ignores gaps between matches, but
        // we want to be aware of them.
        if (lastCharacterParsed !== matchResult.index) {
            throw new Error(
                'Malformed hex file: Could nor parse between characters ' +
                lastCharacterParsed +
                ' and ' +
                matchResult.index +
                ' ("' +
                hexText.substring(lastCharacterParsed, Math.min(matchResult.index, lastCharacterParsed + 16)).trim() +
                '")');
        }
        lastCharacterParsed = hexLineRegexp.lastIndex;

        // Give pretty names to the match's capture groups
        const [undefined, recordStr, recordChecksum] = matchResult;

        // String to Uint8Array - https://stackoverflow.com/questions/43131242/how-to-convert-a-hexademical-string-of-data-to-an-arraybuffer-in-javascript
        const recordBytes = new Uint8Array(recordStr.match(/[\da-f]{2}/gi).map((h)=>parseInt(h, 16)));

        const recordLength = recordBytes[0];
        if (recordLength + 4 !== recordBytes.length) {
            throw new Error('Mismatched record length at record ' + recordCount + ' (' + matchResult[0].trim() + '), expected ' + (recordLength) + ' data bytes but actual length is ' + (recordBytes.length - 4));
        }

        const cs = checksum(recordBytes);
        if (parseInt(recordChecksum, 16) !== cs) {
            throw new Error('Checksum failed at record ' + recordCount + ' (' + matchResult[0].trim() + '), should be ' + cs.toString(16) );
        }

        const offset = (recordBytes[1] << 8) + recordBytes[2];
        const recordType = recordBytes[3];
        let data = recordBytes.subarray(4);

        if (recordType === 0) {
            // Data record, contains data
            // Create a new block, at (upper linear base address + offset)
            if (blocks.has(ulba + offset)) {
                throw new Error('Duplicated data at record ' + recordCount + ' (' + matchResult[0].trim() + ')');
            }
            if (offset + data.length > 0x10000) {
                throw new Error(
                    'Data at record ' +
                    recordCount +
                    ' (' +
                    matchResult[0].trim() +
                    ') wraps over 0xFFFF. This would trigger ambiguous behaviour. Please restructure your data so that for every record the data offset plus the data length do not exceed 0xFFFF.');
            }

            blocks.set( ulba + offset, data );

        } else {

            // All non-data records must have a data offset of zero
            if (offset !== 0) {
                throw new Error('Record ' + recordCount + ' (' + matchResult[0].trim() + ') must have 0000 as data offset.');
            }

            switch (recordType) {
                case 1: // EOF
                    if (lastCharacterParsed !== hexText.length) {
                        // This record should be at the very end of the string
                        throw new Error('There is data after an EOF record at record ' + recordCount);
                    }

                    return joinBlocks(blocks, maxBlockSize);
                    break;

                case 2: // Extended Segment Address Record
                    // Sets the 16 most significant bits of the 20-bit Segment Base
                    // Address for the subsequent data.
                    ulba = ((data[0] << 8) + data[1]) << 4;
                    break;

                case 3: // Start Segment Address Record
                    // Do nothing. Record type 3 only applies to 16-bit Intel CPUs,
                    // where it should reset the program counter (CS+IP CPU registers)
                    break;

                case 4: // Extended Linear Address Record
                    // Sets the 16 most significant (upper) bits of the 32-bit Linear Address
                    // for the subsequent data
                    ulba = ((data[0] << 8) + data[1]) << 16;
                    break;

                case 5: // Start Linear Address Record
                    // Do nothing. Record type 5 only applies to 32-bit Intel CPUs,
                    // where it should reset the program counter (EIP CPU register)
                    // It might have meaning for other CPU architectures
                    // (see http://infocenter.arm.com/help/index.jsp?topic=/com.arm.doc.faqs/ka9903.html )
                    // but will be ignored nonetheless.
                    break;
            }
        }
    }

    if (recordCount) {
        throw new Error('No EOF record at end of file');
    } else {
        throw new Error('Malformed .hex file, could not parse any registers');
    }
}


// Trivial utility. Converts a number to hex and pads with zeroes up to 2 characters.
function hexpad(number) {
    return number.toString(16).toUpperCase().padStart(2, '0');
}


/**
 * Takes a {@link https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Map|<tt>Map</tt>}
 * of {@link https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array|<tt>Uint8Array</tt>}s
 * as a parameter, and returns a <tt>String</tt> of text representing a .hex
 * file.
 * <br/>
 * The input data structure is equivalent to the output of {@link module:nrf-intel-hex~hexToArrays|hexToArrays}.
 * <br/>
 * The writer has an opinionated behaviour. Check the project's
 * {@link https://github.com/NordicSemiconductor/nrf-intel-hex#Features|README file} for details.
 *
 * @param {Map.Uint8Array} blocks The data blocks, indexed by their starting memory address.
 * @param {Number} [lineSize=16] Maximum number of bytes to be encoded in each data record.
 *
 * @return {String} String of text with the .hex representation of the input binary data
 *
 * @example
 * import { arraysToHex } from 'nrf-intel-hex';
 *
 * let blocks = new Map();
 * let bytes = new Uint8Array(....);
 * blocks.set(0x0FF80000, bytes); // The block with 'bytes' will start at offset 0x0FF80000
 *
 * let string = arraysToHex(blocks);
 *
 * @example
 * import { arraysToHex } from 'nrf-intel-hex';
 *
 * // Input can also be in an alternative syntax using a plain object instead of a Map
 * let blocks = {
 *      0: new Uint8Array(....),
 *      0x01F0: new Uint8Array(....)
 * };
 *
 * let string = arraysToHex(blocks);
 */
function arraysToHex(blocks, lineSize = 16) {
    let lowAddress  = 0;    // 16 least significant bits of the current addr
    let highAddress = -1 << 16; // 16 most significant bits of the current addr
    let records = [];
    if (lineSize <=0) {
        throw new Error('Size of record must be greater than zero');
    }

    if (!(blocks instanceof Map)) {
        // Cast the blocks into a map if possible. Namely, when blocks is a plain Object
        // being used as a dictionary with only integer numeric keys
        if (blocks != null && blocks.__proto__ === Object.prototype){
            if (Object.keys(blocks).every((key=>parseInt(key).toString() === key))) {
                blocks = new Map(Object.keys(blocks).map(i=>[parseInt(i), blocks[i]]));
            } else {
                throw new Error('Input of arraysToHex is an Object but it contains non-numeric keys');
            }
        } else {
            throw new Error('Input of arraysToHex is neither a Map nor a plain Object');
        }
    }

    // Placeholders
    let offsetRecord = new Uint8Array(6);
    let recordHeader = new Uint8Array(4);

    let sortedKeys = Array.from(blocks.keys()).sort((a,b)=>a-b);
    for (let i=0,l=sortedKeys.length; i<l; i++) {
        let blockAddr = sortedKeys[i];
        let block = blocks.get(blockAddr);

        // Sanity checks
        if (!(block instanceof Uint8Array)) {
            throw new Error('Block at offset ' + blockAddr + ' is not an Uint8Array');
        }
        if (blockAddr < 0) {
            throw new Error('Block at offset ' + blockAddr + ' has a negative thus invalid address');
        }
        let blockSize = block.length;
        if (!blockSize) { continue; }   // Skip zero-lenght blocks


        if (blockAddr > (highAddress + 0xFFFF)) {
            // Insert a new 0x04 record to jump to a new 64KiB block

            // Round up the least significant 16 bits - no bitmasks because they trigger
            // base-2 negative numbers, whereas subtracting the modulo maintains precision
            highAddress = blockAddr - blockAddr % 0x10000;
            lowAddress = 0;

            offsetRecord[0] = 2;    // Length
            offsetRecord[1] = 0;    // Load offset, high byte
            offsetRecord[2] = 0;    // Load offset, low byte
            offsetRecord[3] = 4;    // Record type
            offsetRecord[4] = highAddress >> 24;    // new address offset, high byte
            offsetRecord[5] = highAddress >> 16;    // new address offset, low byte

            records.push(
                ':' +
                Array.prototype.map.call(offsetRecord, hexpad).join('') +
                hexpad(checksum(offsetRecord))
            );
        }

        if (blockAddr < (highAddress + lowAddress)) {
            throw new Error(
                'Block starting at 0x' +
                blockAddr.toString(16) +
                ' overlaps with a previous block.');
        }

        lowAddress = blockAddr % 0x10000;
        let blockOffset = 0;
        let blockEnd = blockAddr + blockSize;
        if (blockEnd > 0xFFFFFFFF) {
            throw new Error('Data cannot be over 0xFFFFFFFF');
        }

        // Loop for every 64KiB memory segment that spans this block
        while (highAddress + lowAddress < blockEnd) {

            if (lowAddress > 0xFFFF) {
                // Insert a new 0x04 record to jump to a new 64KiB block
                highAddress += 1 << 16; // Increase by one
                lowAddress = 0;

                offsetRecord[0] = 2;    // Length
                offsetRecord[1] = 0;    // Load offset, high byte
                offsetRecord[2] = 0;    // Load offset, low byte
                offsetRecord[3] = 4;    // Record type
                offsetRecord[4] = highAddress >> 24;    // new address offset, high byte
                offsetRecord[5] = highAddress >> 16;    // new address offset, low byte

                records.push(
                    ':' +
                    Array.prototype.map.call(offsetRecord, hexpad).join('') +
                    hexpad(checksum(offsetRecord))
                );
            }

            let recordSize = -1;
            // Loop for every record for that spans the current 64KiB memory segment
            while (lowAddress < 0x10000 && recordSize) {
                recordSize = Math.min(
                    lineSize,                            // Normal case
                    blockEnd - highAddress - lowAddress, // End of block
                    0x10000 - lowAddress,                // End of low addresses
                    255                                  // Maximum record length as per spec
                );

                if (recordSize) {

                    recordHeader[0] = recordSize;   // Length
                    recordHeader[1] = lowAddress >> 8;    // Load offset, high byte
                    recordHeader[2] = lowAddress;    // Load offset, low byte
                    recordHeader[3] = 0;    // Record type

                    let subBlock = block.subarray(blockOffset, blockOffset + recordSize);   // Data bytes for this record

                    records.push(
                        ':' +
                        Array.prototype.map.call(recordHeader, hexpad).join('') +
                        Array.prototype.map.call(subBlock, hexpad).join('') +
                        hexpad(checksumTwo(recordHeader, subBlock))
                    );

                    blockOffset += recordSize;
                    lowAddress += recordSize;
                }
            }
        }
    }

    records.push(":00000001FF");    // EOF record

    return records.join('\n');
}








module.exports = {
    joinBlocks: joinBlocks,
    overlapBlockSets: overlapBlockSets,
    flattenOverlaps: flattenOverlaps,
    paginate: paginate,
    hexToArrays: hexToArrays,
    arraysToHex: arraysToHex
};
