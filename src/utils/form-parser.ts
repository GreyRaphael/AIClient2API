import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

export interface MultipartFile {
    name: string;
    mimetype: string;
    buffer: Buffer;
    size: number;
}

export interface ParsedMultipart {
    fields: Record<string, string>;
    files: Record<string, MultipartFile | MultipartFile[]>;
    fileEntries: Array<{ name: string; file: MultipartFile }>;
}

export interface MultipartParserOptions {
    maxBytes?: number;
    maxFileSizeBytes?: number;
}

export class MultipartError extends Error {
    override statusCode: number;
    clientError: boolean;
    override code?: string;

    constructor(message: string, statusCode = 400, code?: string) {
        super(message);
        this.name = 'MultipartError';
        this.statusCode = statusCode;
        this.clientError = statusCode < 500;
        if (code) {
            this.code = code;
        }
    }
}

/**
 * Filter and collect files matching specified field names from a parsed multipart form.
 */
export function getMultipartFiles(
    form: { fileEntries?: Array<{ name: string; file: MultipartFile | null }>; files?: Record<string, MultipartFile | MultipartFile[] | undefined> },
    fieldNames: string[]
): MultipartFile[] {
    const acceptedNames = new Set<string>(fieldNames);

    if (Array.isArray(form.fileEntries)) {
        return form.fileEntries
            .filter((entry): entry is { name: string; file: MultipartFile } => acceptedNames.has(entry.name) && Boolean(entry.file))
            .map((entry) => entry.file);
    }

    const collected: MultipartFile[] = [];
    if (form.files) {
        for (const name of fieldNames) {
            const value = form.files[name];
            if (Array.isArray(value)) {
                collected.push(...value);
            } else if (value) {
                collected.push(value);
            }
        }
    }
    return collected;
}

/**
 * Parse multipart/form-data from an HTTP IncomingMessage using Node native Web Stream & Response.formData.
 * Completely replaces busboy with zero external dependencies.
 */
export async function parseMultipartForm(
    req: IncomingMessage,
    options: MultipartParserOptions = {}
): Promise<ParsedMultipart> {
    const rawContentType = req.headers['content-type'];
    const contentType = Array.isArray(rawContentType) ? rawContentType.join('; ') : (rawContentType || '');
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
        throw new MultipartError('Content-Type must be multipart/form-data', 400);
    }

    const maxBytes = typeof options.maxBytes === 'number' && options.maxBytes > 0
        ? options.maxBytes
        : 0;

    // 1. Fast-path Content-Length header validation
    const contentLengthHeader = req.headers['content-length'];
    if (contentLengthHeader && maxBytes > 0) {
        const contentLength = parseInt(Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader, 10);
        if (!Number.isNaN(contentLength) && contentLength > maxBytes) {
            if (typeof req.resume === 'function') {
                req.resume();
            }
            throw new MultipartError(`Request body too large. Maximum size is ${maxBytes} bytes.`, 413, 'BODY_TOO_LARGE');
        }
    }

    // 2. Stream chunk byte limiter to guard against chunked/missing content-length attacks
    let totalBytes = 0;
    const limiter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            totalBytes += chunk.byteLength || chunk.length || 0;
            if (maxBytes > 0 && totalBytes > maxBytes) {
                controller.error(new MultipartError(`Request body too large. Maximum size is ${maxBytes} bytes.`, 413, 'BODY_TOO_LARGE'));
                return;
            }
            controller.enqueue(chunk);
        }
    });

    const webStream = Readable.toWeb(req).pipeThrough(limiter);
    const response = new Response(webStream, {
        headers: {
            'content-type': contentType
        }
    });

    let formData: FormData;
    try {
        formData = await response.formData();
    } catch (err: unknown) {
        if (typeof req.resume === 'function') {
            req.resume();
        }
        if (err instanceof MultipartError) {
            throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new MultipartError(message || 'Failed to parse multipart/form-data', 400);
    }

    const fields: Record<string, string> = {};
    const files: Record<string, MultipartFile | MultipartFile[]> = {};
    const fileEntries: Array<{ name: string; file: MultipartFile }> = [];

    for (const [name, value] of formData.entries()) {
        if (typeof value === 'string') {
            fields[name] = value;
        } else if (value && typeof value === 'object' && typeof (value as Blob).arrayBuffer === 'function') {
            const fileObj = value as File;
            if (options.maxFileSizeBytes && options.maxFileSizeBytes > 0 && fileObj.size > options.maxFileSizeBytes) {
                throw new MultipartError(`File "${name}" exceeds size limit of ${options.maxFileSizeBytes} bytes.`, 413, 'FILE_TOO_LARGE');
            }
            const arrayBuffer = await fileObj.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const file: MultipartFile = {
                name: fileObj.name || '',
                mimetype: fileObj.type || 'application/octet-stream',
                buffer,
                size: buffer.length
            };
            fileEntries.push({ name, file });
            const existing = files[name];
            if (!existing) {
                files[name] = file;
            } else if (Array.isArray(existing)) {
                existing.push(file);
            } else {
                files[name] = [existing, file];
            }
        }
    }

    return { fields, files, fileEntries };
}
