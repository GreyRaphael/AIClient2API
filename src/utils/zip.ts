import { deflateRawSync, crc32 } from 'node:zlib';

export interface ZipEntry {
    name: string;
    data: Buffer | string;
    lastModified?: Date;
}

function toDosDateTime(d: Date = new Date()): { time: number; date: number } {
    const hours = d.getHours();
    const minutes = d.getMinutes();
    const seconds = Math.floor(d.getSeconds() / 2);
    const time = (hours << 11) | (minutes << 5) | seconds;

    const year = Math.max(1980, d.getFullYear());
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const date = ((year - 1980) << 9) | (month << 5) | day;

    return { time, date };
}

/**
 * Creates a standard PKZip 2.0 archive buffer from entries using Node native zlib.
 * Zero external dependencies.
 */
export function createZipArchive(entries: ZipEntry[]): Buffer {
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
        const normalizedName = entry.name.replace(/\\/g, '/').replace(/^\/+/, '');
        const nameBuf = Buffer.from(normalizedName, 'utf8');
        const dataBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '', 'utf8');
        const { time, date } = toDosDateTime(entry.lastModified);
        const checksum = crc32(dataBuf);

        const isStored = dataBuf.length === 0;
        const method = isStored ? 0 : 8; // 0 = Stored, 8 = Deflated
        const compressed = isStored ? Buffer.alloc(0) : deflateRawSync(dataBuf);

        // Local file header (30 bytes + name + compressed data)
        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
        localHeader.writeUInt16LE(20, 4);         // Version needed to extract (2.0)
        localHeader.writeUInt16LE(0x0800, 6);     // General purpose bit flag (bit 11 = UTF-8)
        localHeader.writeUInt16LE(method, 8);     // Compression method
        localHeader.writeUInt16LE(time, 10);      // File last modification time
        localHeader.writeUInt16LE(date, 12);      // File last modification date
        localHeader.writeUInt32LE(checksum, 14);  // CRC-32
        localHeader.writeUInt32LE(compressed.length, 18); // Compressed size
        localHeader.writeUInt32LE(dataBuf.length, 22);    // Uncompressed size
        localHeader.writeUInt16LE(nameBuf.length, 26);    // File name length
        localHeader.writeUInt16LE(0, 28);                 // Extra field length

        localParts.push(localHeader, nameBuf, compressed);

        // Central directory file header (46 bytes + name)
        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory file header signature
        centralHeader.writeUInt16LE(20, 4);          // Version made by (2.0)
        centralHeader.writeUInt16LE(20, 6);          // Version needed to extract (2.0)
        centralHeader.writeUInt16LE(0x0800, 8);      // General purpose bit flag (UTF-8)
        centralHeader.writeUInt16LE(method, 10);     // Compression method
        centralHeader.writeUInt16LE(time, 12);       // File last modification time
        centralHeader.writeUInt16LE(date, 14);       // File last modification date
        centralHeader.writeUInt32LE(checksum, 16);   // CRC-32
        centralHeader.writeUInt32LE(compressed.length, 20); // Compressed size
        centralHeader.writeUInt32LE(dataBuf.length, 24);    // Uncompressed size
        centralHeader.writeUInt16LE(nameBuf.length, 28);    // File name length
        centralHeader.writeUInt16LE(0, 30);                 // Extra field length
        centralHeader.writeUInt16LE(0, 32);                 // File comment length
        centralHeader.writeUInt16LE(0, 34);                 // Disk number start
        centralHeader.writeUInt16LE(0, 36);                 // Internal file attributes
        centralHeader.writeUInt32LE(0x81a40000, 38);        // External file attributes (regular file -rw-r--r--)
        centralHeader.writeUInt32LE(offset, 42);            // Relative offset of local header

        centralParts.push(centralHeader, nameBuf);
        offset += localHeader.length + nameBuf.length + compressed.length;
    }

    const centralDirectory = Buffer.concat(centralParts);
    const centralDirSize = centralDirectory.length;
    const centralDirOffset = offset;

    // End of central directory record (22 bytes)
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);          // End of central dir signature
    eocd.writeUInt16LE(0, 4);                   // Number of this disk
    eocd.writeUInt16LE(0, 6);                   // Disk where central directory starts
    eocd.writeUInt16LE(entries.length, 8);      // Number of central directory records on this disk
    eocd.writeUInt16LE(entries.length, 10);     // Total number of central directory records
    eocd.writeUInt32LE(centralDirSize, 12);      // Size of central directory
    eocd.writeUInt32LE(centralDirOffset, 16);    // Offset of start of central directory
    eocd.writeUInt16LE(0, 20);                  // ZIP file comment length

    return Buffer.concat([...localParts, centralDirectory, eocd]);
}

/**
 * Drop-in helper matching the basic AdmZip interface for building zip buffers.
 */
export class SimpleZip {
    private entries: ZipEntry[] = [];

    addFile(entryName: string, content: Buffer | string, lastModified?: Date): void {
        this.entries.push({ name: entryName, data: content, lastModified });
    }

    toBuffer(): Buffer {
        return createZipArchive(this.entries);
    }
}
