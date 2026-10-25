// Minimal local typings for the adm-zip 0.5.x API surface used by the gateway.
// adm-zip 0.5.16 ships no .d.ts file and @types/adm-zip 0.6.x is a deprecated
// stub that points back to the (untyped) package, so declare the exact surface
// we use instead of falling back to an implicit `any` module.

declare module 'adm-zip' {
    interface ZipEntry {
        entryName: string;
        isDirectory: boolean;
        getData(): Buffer;
    }

    export default class AdmZip {
        constructor(fileName?: string | Buffer);
        getEntries(): ZipEntry[];
        addFile(entryName: string, content: Buffer | string): void;
        toBuffer(): Buffer;
    }
}
