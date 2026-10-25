/**
 * 首内容前缓冲。
 *
 * 上游在首个有效内容（文本/工具调用/内联数据）出现前可能只发 thinking，
 * 随后以空响应结束。为了让这类失败可以无损重试，这里把出站 SSE 帧先缓存，
 * 等有效内容出现后一次性冲刷；流结束仍无有效内容时直接丢弃。
 */

export interface PreContentBufferPushResult {
    framesToWrite: string[];
    overflowed: boolean;
    frameCount: number;
    byteLength: number;
}

export class PreContentBuffer {
    private frames: string[] = [];
    private bytes = 0;
    private readonly maxFrames: number;
    private readonly maxBytes: number;

    constructor(maxFrames: number, maxBytes: number) {
        this.maxFrames = maxFrames;
        this.maxBytes = maxBytes;
    }

    get length(): number {
        return this.frames.length;
    }

    get byteLength(): number {
        return this.bytes;
    }

    /**
     * 缓存新帧。超过上限时返回全部缓存帧并清空，调用方应视为“提前冲刷”。
     */
    push(frames: string[]): PreContentBufferPushResult {
        for (const frame of frames) {
            this.frames.push(frame);
            this.bytes += Buffer.byteLength(frame, 'utf8');
        }

        if (this.frames.length > this.maxFrames || this.bytes > this.maxBytes) {
            const frameCount = this.frames.length;
            const byteLength = this.bytes;
            return { framesToWrite: this.takeAll(), overflowed: true, frameCount, byteLength };
        }

        return { framesToWrite: [], overflowed: false, frameCount: this.frames.length, byteLength: this.bytes };
    }

    /**
     * 首次出现有效内容时冲刷全部缓存。
     */
    flush(): string[] {
        return this.takeAll();
    }

    /**
     * 空响应重试/客户端断开时丢弃全部缓存。
     */
    discard(): string[] {
        return this.takeAll();
    }

    private takeAll(): string[] {
        const buffered = this.frames;
        this.frames = [];
        this.bytes = 0;
        return buffered;
    }
}
