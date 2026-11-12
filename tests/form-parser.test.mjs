import { describe, test, beforeEach, afterEach } from 'node:test';
import { expect } from './support/harness.mjs';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseMultipartForm, getMultipartFiles, MultipartError } from '../src/utils/form-parser.ts';
import { handleUploadOAuthCredentials } from '../src/ui-modules/event-broadcast.ts';

function createMultipartBody(parts, boundary = '----TestBoundary12345') {
    const lines = [];
    for (const part of parts) {
        lines.push(`--${boundary}`);
        if (part.filename !== undefined) {
            lines.push(`Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"`);
            lines.push(`Content-Type: ${part.contentType || 'application/octet-stream'}`);
        } else {
            lines.push(`Content-Disposition: form-data; name="${part.name}"`);
        }
        lines.push('');
        lines.push(part.value);
    }
    lines.push(`--${boundary}--`);
    lines.push('');
    return {
        boundary,
        buffer: Buffer.from(lines.join('\r\n'), 'utf-8'),
        contentType: `multipart/form-data; boundary=${boundary}`
    };
}

function createMockRequest({ body, contentType, contentLength, headers = {} }) {
    const stream = Readable.from(body ? [body] : []);
    stream.headers = {
        'content-type': contentType,
        ...(contentLength !== undefined ? { 'content-length': String(contentLength) } : {}),
        ...headers
    };
    return stream;
}

function createMockResponse() {
    return {
        statusCode: 200,
        headers: {},
        body: '',
        writableEnded: false,
        writeHead(statusCode, headers = {}) {
            this.statusCode = statusCode;
            this.headers = { ...this.headers, ...headers };
            return this;
        },
        end(data) {
            if (data !== undefined && data !== null) {
                this.body += String(data);
            }
            this.writableEnded = true;
            return this;
        }
    };
}

describe('form-parser utility', () => {
    test('rejects non-multipart content type with 400', async () => {
        const req = createMockRequest({
            body: Buffer.from('hello=world'),
            contentType: 'application/x-www-form-urlencoded'
        });

        await expect(parseMultipartForm(req)).rejects.toThrow('Content-Type must be multipart/form-data');
    });

    test('parses text fields and single files correctly', async () => {
        const { buffer, contentType } = createMultipartBody([
            { name: 'prompt', value: 'a photograph of sunrise' },
            { name: 'model', value: 'gemini-3.1-flash' },
            { name: 'image', filename: 'photo.jpg', contentType: 'image/jpeg', value: 'FAKE_JPEG_BINARY' }
        ]);

        const req = createMockRequest({ body: buffer, contentType });
        const form = await parseMultipartForm(req);

        expect(form.fields.prompt).toBe('a photograph of sunrise');
        expect(form.fields.model).toBe('gemini-3.1-flash');
        expect(form.files.image).toBeDefined();

        const file = Array.isArray(form.files.image) ? form.files.image[0] : form.files.image;
        expect(file.name).toBe('photo.jpg');
        expect(file.mimetype).toBe('image/jpeg');
        expect(file.buffer.toString()).toBe('FAKE_JPEG_BINARY');
        expect(file.size).toBe(Buffer.byteLength('FAKE_JPEG_BINARY'));
    });

    test('parses multiple files under repeated field names (e.g. image[])', async () => {
        const { buffer, contentType } = createMultipartBody([
            { name: 'image[]', filename: '1.png', contentType: 'image/png', value: 'IMG1' },
            { name: 'image[]', filename: '2.png', contentType: 'image/png', value: 'IMG2' }
        ]);

        const req = createMockRequest({ body: buffer, contentType });
        const form = await parseMultipartForm(req);

        expect(Array.isArray(form.files['image[]'])).toBe(true);
        expect(form.files['image[]'].length).toBe(2);
        expect(form.fileEntries.length).toBe(2);

        const extracted = getMultipartFiles(form, ['image', 'image[]']);
        expect(extracted.length).toBe(2);
        expect(extracted[0].buffer.toString()).toBe('IMG1');
        expect(extracted[1].buffer.toString()).toBe('IMG2');
    });

    test('rejects when content-length exceeds maxBytes', async () => {
        const { buffer, contentType } = createMultipartBody([
            { name: 'field', value: 'x'.repeat(100) }
        ]);

        const req = createMockRequest({
            body: buffer,
            contentType,
            contentLength: buffer.length
        });

        await expect(parseMultipartForm(req, { maxBytes: 50 })).rejects.toThrow('Request body too large');
    });

    test('rejects when streaming chunks exceed maxBytes (chunked without content-length)', async () => {
        const { buffer, contentType } = createMultipartBody([
            { name: 'field', value: 'y'.repeat(500) }
        ]);

        const req = createMockRequest({
            body: buffer,
            contentType
        });

        await expect(parseMultipartForm(req, { maxBytes: 100 })).rejects.toThrow('Request body too large');
    });

    test('rejects when an individual file exceeds maxFileSizeBytes', async () => {
        const { buffer, contentType } = createMultipartBody([
            { name: 'doc', filename: 'large.pdf', contentType: 'application/pdf', value: 'A'.repeat(500) }
        ]);

        const req = createMockRequest({ body: buffer, contentType });
        await expect(parseMultipartForm(req, { maxFileSizeBytes: 100 })).rejects.toThrow('exceeds size limit');
    });

    test('handles malformed multipart body gracefully', async () => {
        const req = createMockRequest({
            body: Buffer.from('Not a valid multipart payload'),
            contentType: 'multipart/form-data; boundary=invalid'
        });

        await expect(parseMultipartForm(req)).rejects.toThrow();
    });
});

describe('handleUploadOAuthCredentials with native form parser', () => {
    const testProvider = 'test_upload_prov';
    const testDir = path.join(process.cwd(), 'configs', testProvider);

    afterEach(async () => {
        await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
        const tempDir = path.join(process.cwd(), 'configs', 'temp');
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    });

    test('rejects non-multipart requests with 400', async () => {
        const req = createMockRequest({
            body: Buffer.from('test'),
            contentType: 'application/json'
        });
        const res = createMockResponse();

        const handled = await handleUploadOAuthCredentials(req, res);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(400);
        const data = JSON.parse(res.body);
        expect(data.error.message).toContain('Content-Type must be multipart/form-data');
    });

    /**
     * 回归守护：超限必须是 413，不能被降级成 400。
     *
     * MultipartError 自带 statusCode=413，但 handleUploadOAuthCredentials 过去
     * 硬编码 writeHead(400)，把「请求太大」和「报文坏了」混为一谈，
     * 客户端与监控都无法据此区分。
     */
    test('over-limit body returns 413, not 400', async () => {
        const big = 'x'.repeat(6 * 1024 * 1024); // > MAX_UPLOAD_FILE_SIZE(5MB)
        const { buffer, contentType } = createMultipartBody([
            { name: 'provider', value: testProvider },
            { name: 'file', filename: 'creds.json', value: big }
        ]);
        const req = createMockRequest({ body: buffer, contentType });
        const res = createMockResponse();

        await handleUploadOAuthCredentials(req, res);

        expect(res.statusCode).toBe(413);
        const data = JSON.parse(res.body);
        expect(data.error.message).toContain('too large');
    });

    test('rejects missing file with 400', async () => {
        const { buffer, contentType } = createMultipartBody([
            { name: 'provider', value: testProvider }
        ]);
        const req = createMockRequest({ body: buffer, contentType });
        const res = createMockResponse();

        await handleUploadOAuthCredentials(req, res);
        expect(res.statusCode).toBe(400);
        const data = JSON.parse(res.body);
        expect(data.error.message).toBe('No file was uploaded');
    });

    test('rejects unsupported file extension with 400', async () => {
        const { buffer, contentType } = createMultipartBody([
            { name: 'provider', value: testProvider },
            { name: 'file', filename: 'malicious.exe', value: 'MZ90' }
        ]);
        const req = createMockRequest({ body: buffer, contentType });
        const res = createMockResponse();

        await handleUploadOAuthCredentials(req, res);
        expect(res.statusCode).toBe(400);
        const data = JSON.parse(res.body);
        expect(data.error.message).toBe('Unsupported file type');
    });

    test('successfully uploads and stores valid credentials file', async () => {
        const fileContent = JSON.stringify({ client_id: 'test-123', client_secret: 'secret-456' });
        const { buffer, contentType } = createMultipartBody([
            { name: 'provider', value: testProvider },
            { name: 'file', filename: 'client_secrets.json', contentType: 'application/json', value: fileContent }
        ]);

        const req = createMockRequest({ body: buffer, contentType });
        const res = createMockResponse();

        const handled = await handleUploadOAuthCredentials(req, res);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);

        const data = JSON.parse(res.body);
        expect(data.success).toBe(true);
        expect(data.provider).toBe(testProvider);
        expect(data.originalName).toBe('client_secrets.json');

        const savedFilePath = path.join(process.cwd(), data.filePath);
        const savedContent = await fs.readFile(savedFilePath, 'utf-8');
        expect(savedContent).toBe(fileContent);
    });
});
