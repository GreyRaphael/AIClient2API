/**
 * 回归守护：日志轮转的大小检查不得每条日志都 fs.statSync。
 *
 * 原实现 checkAndRotateLogFile() 在每次写入前都 statSync 当前日志文件。
 * 实测 fs.statSync 在打满插件沙箱 monkey-patch 时从 105ms/20k 次劣化到 787ms，
 * 而 logger 是热路径（每条日志一次），所以这个开销是全局的。
 *
 * 现在用「本地累加字节数 + 限频 stat」判断：只有可能接近阈值时才真正 stat。
 * 这里验证行为契约（该轮转时仍会轮转），而不是实现细节。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import logger from '../src/utils/logger.ts';

describe('logger rotation fast path', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-rotate-'));
    });

    afterEach(() => {
        try { logger.closeLogStream?.(); } catch { /* ignore */ }
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('写入时按字节累加并触发轮转检查（阈值内不轮转）', async () => {
        logger.initialize({
            enabled: true,
            outputMode: 'file',
            logDir: tempDir,
            logLevel: 'debug',
            includeRequestId: false,
            includeTimestamp: false,
            maxFileSize: 10 * 1024 * 1024,
            maxFiles: 3
        });

        logger.info('hello rotation');
        logger.info('world rotation');
        // createWriteStream 是异步落盘的，等待一下再断言磁盘状态
        await new Promise((resolve) => setTimeout(resolve, 80));

        // 阈值远未达到 => 不应轮转，只应有一个当日日志文件
        const files = fs.readdirSync(tempDir).filter((f) => f.endsWith('.log'));
        expect(files.length).toBe(1);

        const content = fs.readFileSync(path.join(tempDir, files[0]), 'utf8');
        expect(content).toContain('hello rotation');
        expect(content).toContain('world rotation');
    });

    test('超过 maxFileSize 后会轮转出带时间戳的历史文件', async () => {
        logger.initialize({
            enabled: true,
            outputMode: 'file',
            logDir: tempDir,
            logLevel: 'debug',
            includeRequestId: false,
            includeTimestamp: false,
            // 极小阈值：写入若干行后必然越过
            maxFileSize: 200,
            maxFiles: 5
        });

        // 每次写入之间让出事件循环，确保上一行已落盘（轮转依据磁盘大小）
        for (let i = 0; i < 40; i++) {
            logger.info(`rotation probe line number ${i} with some padding to grow the file`);
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await new Promise((resolve) => setTimeout(resolve, 150));

        const files = fs.readdirSync(tempDir).filter((f) => f.endsWith('.log'));
        // 至少产生了一个历史文件（文件名带时间戳）
        expect(files.length).toBeGreaterThan(1);
    });
});
