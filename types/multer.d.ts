// Minimal local typings for multer, tailored to this non-Express server.
//
// `@types/multer` (2.x) models Express Request/Response objects, while the
// gateway passes Node's IncomingMessage/ServerResponse directly to the multer
// middleware. Importing those types forces Express into the dependency graph
// and rejects valid call sites, so we declare only the surface used here.

declare module 'multer' {
    import type { IncomingMessage } from 'node:http';

    namespace Multer {
        interface File {
            fieldname: string;
            originalname: string;
            encoding: string;
            mimetype: string;
            size: number;
            destination?: string;
            filename?: string;
            path?: string;
            buffer?: Buffer;
            [key: string]: unknown;
        }

        type DestinationCallback = (error: Error | null, destination?: string) => void;
        type FileNameCallback = (error: Error | null, filename?: string) => void;
        type FileFilterCallback = (error: Error | null, acceptFile?: boolean) => void;
        type NextFunction = (error?: unknown) => void;

        interface StorageEngine {
            _handleFile(
                req: IncomingMessage,
                file: File,
                callback: (error?: unknown, info?: Partial<File>) => void
            ): void;
            _removeFile(
                req: IncomingMessage,
                file: File,
                callback: (error?: Error | null) => void
            ): void;
        }

        interface DiskStorageOptions {
            destination?:
                | string
                | ((req: IncomingMessage, file: File, callback: DestinationCallback) => void);
            filename?: (req: IncomingMessage, file: File, callback: FileNameCallback) => void;
        }

        interface StorageOptions {
            [key: string]: unknown;
        }

        interface Options {
            storage?: StorageEngine;
            dest?: string;
            limits?: {
                fileSize?: number;
                files?: number;
                fields?: number;
                parts?: number;
                headerPairs?: number;
            };
            fileFilter?: (req: IncomingMessage, file: File, callback: FileFilterCallback) => void;
            preservePath?: boolean;
        }

        type RequestHandler = (req: unknown, res: unknown, next: NextFunction) => void;

        interface Instance {
            single(fieldName: string): RequestHandler;
            array(fieldName: string, maxCount?: number): RequestHandler;
            fields(fields: Array<{ name: string; maxCount?: number }>): RequestHandler;
            none(): RequestHandler;
        }

        interface Multer {
            (options?: Options): Instance;
            diskStorage(options: DiskStorageOptions): StorageEngine;
            memoryStorage(options?: StorageOptions): StorageEngine;
        }
    }

    const multer: Multer.Multer;

    export type File = Multer.File;
    export type StorageEngine = Multer.StorageEngine;
    export type DiskStorageOptions = Multer.DiskStorageOptions;
    export type Options = Multer.Options;
    export type Instance = Multer.Instance;

    export default multer;
}
