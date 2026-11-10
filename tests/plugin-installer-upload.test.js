import { describe, expect, test, afterEach } from '@jest/globals';
import AdmZip from 'adm-zip';
import { promises as fs } from 'fs';
import path from 'path';
import {
    validatePluginArchiveBuffer,
    installPluginFromBuffer
} from '../src/services/plugin-installer.ts';

const TEST_PLUGIN_ID = 'test-upload-plugin';
const PLUGINS_DIR = path.join(process.cwd(), 'src', 'plugins-user');
const targetPluginDir = path.join(PLUGINS_DIR, TEST_PLUGIN_ID);

afterEach(async () => {
    try {
        await fs.rm(targetPluginDir, { recursive: true, force: true });
    } catch {
        // ignore cleanup error
    }
});

describe('plugin-installer upload functionality', () => {
    test('validates safe plugin archive buffer successfully', () => {
        const zip = new AdmZip();
        zip.addFile('index.js', Buffer.from('module.exports = { name: "test" };\n'));
        const buffer = zip.toBuffer();

        expect(() => validatePluginArchiveBuffer(buffer, TEST_PLUGIN_ID)).not.toThrow();
    });

    test('rejects plugin archive containing dangerous patterns', () => {
        const zip = new AdmZip();
        zip.addFile('index.js', Buffer.from("const cp = require('child_process');\n"));
        const buffer = zip.toBuffer();

        expect(() => validatePluginArchiveBuffer(buffer, TEST_PLUGIN_ID)).toThrow(/child_process/);
    });

    test('rejects buffer exceeding maximum allowed size', async () => {
        const largeBuffer = Buffer.alloc(11 * 1024 * 1024);
        await expect(installPluginFromBuffer(TEST_PLUGIN_ID, largeBuffer)).rejects.toThrow(
            /exceeds maximum allowed size/
        );
    });

    test('rejects plugin with invalid ID', async () => {
        const zip = new AdmZip();
        zip.addFile('index.js', Buffer.from('module.exports = {};\n'));
        const buffer = zip.toBuffer();

        await expect(installPluginFromBuffer('../evil-id', buffer)).rejects.toThrow();
    });

    test('rejects plugin archive missing index.js', async () => {
        const zip = new AdmZip();
        zip.addFile('README.md', Buffer.from('# Readme\n'));
        const buffer = zip.toBuffer();

        await expect(installPluginFromBuffer(TEST_PLUGIN_ID, buffer)).rejects.toThrow(
            /未找到 index.js/
        );
    });

    test('installs valid plugin archive and creates files', async () => {
        const zip = new AdmZip();
        zip.addFile('index.js', Buffer.from('module.exports = { version: "1.0.0" };\n'));
        zip.addFile('package.json', Buffer.from('{"name": "test-plugin"}\n'));
        const buffer = zip.toBuffer();

        const result = await installPluginFromBuffer(TEST_PLUGIN_ID, buffer);
        expect(result).toBe(true);

        const indexFile = await fs.readFile(path.join(targetPluginDir, 'index.js'), 'utf8');
        expect(indexFile).toContain('version: "1.0.0"');
    });
});
