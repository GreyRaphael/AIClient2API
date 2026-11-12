import { describe, test, beforeEach, afterEach } from 'node:test';
import { expect } from './support/harness.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { createZipArchive, SimpleZip } from '../src/utils/zip.ts';
import { handleDownloadAllConfigs } from '../src/ui-modules/upload-config-api.ts';

/**
 * Minimal ZIP reader for testing that verifies PKZip 2.0 structures without external tools.
 */
function parseZip(buffer) {
    const entries = [];
    let offset = 0;

    // Read Local File Headers
    while (offset < buffer.length) {
        const sig = buffer.readUInt32LE(offset);
        if (sig === 0x02014b50 || sig === 0x06054b50) {
            // Reached Central Directory or EOCD
            break;
        }
        if (sig !== 0x04034b50) {
            throw new Error(`Invalid local header signature 0x${sig.toString(16)} at offset ${offset}`);
        }

        const method = buffer.readUInt16LE(offset + 8);
        const crc = buffer.readUInt32LE(offset + 14);
        const compressedSize = buffer.readUInt32LE(offset + 18);
        const uncompressedSize = buffer.readUInt32LE(offset + 22);
        const nameLen = buffer.readUInt16LE(offset + 26);
        const extraLen = buffer.readUInt16LE(offset + 28);

        const name = buffer.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
        const dataStart = offset + 30 + nameLen + extraLen;
        const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);

        let data;
        if (method === 0) {
            data = compressedData;
        } else if (method === 8) {
            data = inflateRawSync(compressedData);
        } else {
            throw new Error(`Unsupported compression method ${method}`);
        }

        entries.push({
            name,
            method,
            crc,
            uncompressedSize,
            compressedSize,
            data
        });

        offset = dataStart + compressedSize;
    }

    return entries;
}

function createMockResponse() {
    return {
        statusCode: null,
        headers: {},
        body: Buffer.alloc(0),
        writeHead(status, headers = {}) {
            this.statusCode = status;
            this.headers = { ...this.headers, ...headers };
            return this;
        },
        end(data) {
            if (data) {
                this.body = Buffer.isBuffer(data) ? data : Buffer.from(data);
            }
            return this;
        }
    };
}

describe('SimpleZip and createZipArchive', () => {
    test('creates an empty zip archive', () => {
        const zip = createZipArchive([]);
        expect(Buffer.isBuffer(zip)).toBe(true);
        expect(zip.length).toBe(22); // Only EOCD
        const entries = parseZip(zip);
        expect(entries.length).toBe(0);
    });

    test('archives empty and non-empty files with nested paths', () => {
        const zip = new SimpleZip();
        zip.addFile('empty.txt', '');
        zip.addFile('hello.txt', 'Hello, Node 26!');
        zip.addFile('sub/dir/config.json', JSON.stringify({ key: 'value' }));
        zip.addFile('binary.bin', Buffer.from([0x01, 0x02, 0x03, 0x04]));

        const buf = zip.toBuffer();
        const entries = parseZip(buf);

        expect(entries.length).toBe(4);
        expect(entries[0].name).toBe('empty.txt');
        expect(entries[0].uncompressedSize).toBe(0);
        expect(entries[0].data.length).toBe(0);

        expect(entries[1].name).toBe('hello.txt');
        expect(entries[1].data.toString('utf8')).toBe('Hello, Node 26!');

        expect(entries[2].name).toBe('sub/dir/config.json');
        expect(JSON.parse(entries[2].data.toString('utf8'))).toEqual({ key: 'value' });

        expect(entries[3].name).toBe('binary.bin');
        expect(entries[3].data.equals(Buffer.from([0x01, 0x02, 0x03, 0x04]))).toBe(true);
    });

    test('supports UTF-8 filenames and normalizes backslashes', () => {
        const zip = new SimpleZip();
        zip.addFile('测试目录\\配置文件.json', '{"status":"ok"}');

        const buf = zip.toBuffer();
        const entries = parseZip(buf);

        expect(entries.length).toBe(1);
        expect(entries[0].name).toBe('测试目录/配置文件.json');
        expect(entries[0].data.toString('utf8')).toBe('{"status":"ok"}');
    });
});

describe('handleDownloadAllConfigs with native SimpleZip', () => {
    let tempDir;
    let originalCwd;

    beforeEach(async () => {
        originalCwd = process.cwd();
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-test-'));
        process.chdir(tempDir);
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    });

    test('returns 404 when configs directory does not exist', async () => {
        const res = createMockResponse();
        const handled = await handleDownloadAllConfigs({}, res);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(404);
        expect(JSON.parse(res.body.toString()).error.message).toContain('configs directory does not exist');
    });

    test('zips configs directory and excludes .master_secret', async () => {
        const configsDir = path.join(tempDir, 'configs');
        await fs.mkdir(path.join(configsDir, 'antigravity'), { recursive: true });
        await fs.writeFile(path.join(configsDir, 'antigravity', 'cred.json'), '{"token":"123"}');
        await fs.writeFile(path.join(configsDir, 'common.json'), '{"mode":"test"}');
        await fs.writeFile(path.join(configsDir, '.master_secret'), 'SECRET_DO_NOT_LEAK');

        const res = createMockResponse();
        const handled = await handleDownloadAllConfigs({}, res);

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res.headers['Content-Type']).toBe('application/zip');
        expect(res.headers['Content-Disposition']).toContain('configs_backup_');

        const entries = parseZip(res.body);
        const names = entries.map((e) => e.name).sort();

        expect(names).toEqual(['antigravity/cred.json', 'common.json']);
        expect(names.includes('.master_secret')).toBe(false);
    });
});
