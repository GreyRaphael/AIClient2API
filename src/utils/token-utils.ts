type UnknownRecord = Record<string, unknown>;

import logger from './logger.ts';
import { getErrorMessage } from './error.ts';
import { isRecord } from './type-guards.ts';

// BPE 预分词模式（对齐 Claude / GPT 的切分规则）。
// 用 `v` 标志的集合差集把 CJK 从 \p{L} 里剔除，让 CJK 单独成支路：
//   [\p{L}--[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]]
// 数字用 \p{N} 而不是 \d：\d 只匹配 ASCII 0-9，而兜底支路又排除了 \p{N}，
// 于是 Ⅳ / ٠١٢ / १२३ 这类数字会被整类静默丢弃、既不计数也不报错。
// 注意：Hangul 不放在逐字支路里。
// 实测谚文是**按词**切子词的：'안녕하세요'(5 音节)→7、'오늘'(2)→4、'세계'(2)→4，
// 即短词约 2 token/音节，而长句平均只有 1.17——用统一的「每字比率」两头都不对。
// 因此单独走词级支路（见 SCRIPT_RATIO 的 hangul 项）。
const CJK_CLASS = '\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}';
const TOKEN_PATTERN_SRC = [
    "(?:'s|'t|'re|'ve|'m|'ll|'d)",                 // 英文缩写
    `[^\\S\\r\\n]?[${CJK_CLASS}]`,                  // CJK 单字（含前导空格）
    `[^\\S\\r\\n]?[\\p{L}--[${CJK_CLASS}]]+`,       // 其余字母串（含前导空格）
    '[^\\S\\r\\n]?\\p{N}+',                         // 数字（含非 ASCII 数字）
    '[^\\S\\r\\n]?[^\\s\\p{L}\\p{N}]+',             // 符号/标点（含前导空格）
    '\\s+'                                          // 空白（整块，含换行）
].join('|');
const CJK_PATTERN = new RegExp(`[${CJK_CLASS}]`, 'v');

/**
 * 编码块字符集：base64 / base64url / hex / UUID / JWT 片段。
 * 只允许 ASCII 字母数字加上 `= + / - _ .`，且至少 16 个字符。
 * 用于把「无空白的编码块」和「无空白的紧凑 JSON / CJK 短句」区分开。
 */
const ENCODED_BLOB_PATTERN = /^[A-Za-z0-9=+/_.-]{16,}$/;
const DIGIT_PATTERN = /^\p{N}+$/v;
const WORD_PATTERN = new RegExp(`^[\\p{L}--[${CJK_CLASS}]]+$`, 'v');
const WS_PATTERN = /^\s+$/;

/**
 * 各文字系统的 token 估算参数，由真实 BPE 实测标定。
 *
 * 关键洞察一：非拉丁字母**不能**和英文单词用同一条「每词 1 token」的规则。
 * 实测同一句话（~65 字符）：英文 13 token、法文 23、德文 20，
 * 而希腊 74、阿拉伯 41、希伯来 40、泰文 89。英文便宜是因为 BPE 词表
 * 几乎被英文占满；其余文字基本退化成按字节/子词切。
 * 旧实现把这些全按英文处理，希腊语会低估 77%。
 *
 * 关键洞察二：用 **UTF-8 字节数**做自变量比用「字符数」稳得多。
 * 因为这些文字基本是「每 2~3 字节一个子词」，字节数与 BPE 的切分单位直接对应；
 * 而字符数在不同文字之间含义完全不同（一个汉字 = 3 字节 = 1 音节）。
 * 实测「每字节 token 数」在各文字间落在 0.23~0.59 的窄区间，
 * 用字符数拟合的残差明显更大。
 *
 * 拟合形式：`max(1, round(utf8Bytes * perByte + extra))`。
 * `extra` 是不可压缩的子词起步成本——短词（2~4 字节）实测也要 1~2 token，
 * 纯比例会把它们压到 1。
 */
const SCRIPT_RATIO = [
    { pattern: /\p{sc=Thai}/u, perByte: 0.545, extra: 1.9 },
    { pattern: /\p{sc=Devanagari}/u, perByte: 0.41, extra: 0 },
    { pattern: /\p{sc=Greek}/u, perByte: 0.585, extra: 0 },
    { pattern: /\p{sc=Hebrew}/u, perByte: 0.49, extra: 0.3 },
    { pattern: /\p{sc=Arabic}/u, perByte: 0.38, extra: 0.8 },
    { pattern: /\p{sc=Cyrillic}/u, perByte: 0.23, extra: 0.7 },
    { pattern: /\p{sc=Hangul}/u, perByte: 0.49, extra: 0.1 }
];

/**
 * CJK 逐字支路。这些文字 BPE 基本按「一字一子词」切，直接用每字系数最准；
 * 用字节反而会因为「汉字 3 字节 / 假名 3 字节」把不同文字压成同一档。
 * 实测每字：汉字 1.12、平假名 1.00、片假名 1.14。
 */
const CJK_RATIO = [
    { pattern: /\p{sc=Han}/u, perChar: 1.12 },
    { pattern: /\p{sc=Katakana}/u, perChar: 1.14 },
    { pattern: /\p{sc=Hiragana}/u, perChar: 1.0 }
];

/** UTF-8 字节数（BPE 子词的单位，比字符数更能跨文字比较） */
function utf8ByteLength(text: string): number {
    return Buffer.byteLength(text, 'utf8');
}

function getPartText(part: unknown): string {
    if (typeof part === 'string') return part;
    if (isRecord(part)) {
        if (part.type === 'text' && typeof part.text === 'string') return part.text;
        if (typeof part.text === 'string') return part.text;
    }
    return '';
}

/**
 * Extract text content from message format
 */
function getContentText(message: unknown): string {
    if (message == null) {
        return "";
    }
    if (Array.isArray(message)) {
        return message.map(getPartText).join('');
    }
    if (isRecord(message)) {
        const content = message.content;
        if (typeof content === 'string') {
            return content;
        }
        if (Array.isArray(content)) {
            return content.map(getPartText).join('');
        }
        return String(content || message);
    }
    return String(message);
}

/**
 * Process content blocks into text
 * @param {unknown} content - content object or array
 * @returns {string} processed text
 */
function processContent(content: unknown): string {
    if (!content) return "";
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            if (isRecord(part)) {
                if (part.type === 'text') return typeof part.text === 'string' ? part.text : "";
                if (part.type === 'thinking') {
                    if (typeof part.thinking === 'string') return part.thinking;
                    if (typeof part.text === 'string') return part.text;
                    return "";
                }
                if (part.type === 'tool_result') return processContent(part.content);
                if (part.type === 'tool_use' && part.input) return JSON.stringify(part.input);
                if (typeof part.text === 'string') return part.text;
            }
            return "";
        }).join("");
    }
    return getContentText(content);
}

/**
 * 统计文本的 token 数（零依赖启发式估算）。
 *
 * 口径说明（重要）：这是**估算**，不是精确 BPE。
 * 它按 BPE 预分词规则切块，再按块类型给权重（权重全部由真实
 * @anthropic-ai/tokenizer 的实测输出标定）。
 *
 * 实测精度（对真实 Claude BPE）：
 *   - 20 条代表性载荷：平均偏差 **6.5%**；英文长散文与代码可低至 0%
 *   - 达标项：英文对话/长文、TypeScript/Python 代码、中文（±4%）、日志行
 *   - 短板（10~25%）：JSON/工具定义、短句阿拉伯语、纯 emoji 串、
 *     以及 CJK 与拉丁混排
 *   - 换一组**未参与调参**的留出集，平均偏差约 11.7%——明显差于训练集，
 *     说明确实存在过拟合，对外不要按 6.9% 承诺精度
 *
 * 已知的方法论下界：真实 BPE 有**跨边界上下文效应**
 * （同一个 JSON 文档整体 39 token，但把它切成 31 个块分别计只有 32），
 * 逐块打分的启发式永远拿不到这部分。
 * 另外「编码块」（整段无空白且只含 base64 字符集）走单独分支按 0.72/字符 估算，
 * 这是目前唯一能稳定覆盖 base64/JWT/hash 的做法。
 *
 * 不要把它当作计费依据；`/count_tokens` 用它只是给客户端一个
 * 合理的上下文预算参考。需要精确值时应当走上游官方 count_tokens 接口。
 *
 * 锚定用例见 tests/token-utils.test.mjs 的 ACCURACY_BASELINE ——
 * 里面的 ref 值都是真实分词器跑出来的，不是凭感觉写的。
 */
export function countTextTokens(text: string): number {
    if (!text) return 0;
    try {
        // 整段没有任何空白 + 只由编码字符集构成 ⇒ 这是一个编码块
        // （base64 / hex / JWT / hash）。
        //
        // 「无空白」是唯一可靠的判据：实测无空白整段的 ref/字符 稳定在 0.55~1.00
        // （base64 0.667、uuid 0.583、sha256 0.547、hex 1.000），
        // 而自然语言整段是 0.17~0.21，两者相差 3~5 倍、不存在重叠区。
        //
        // 但必须同时要求「只含 base64 字符集」：紧凑 JSON（{"a":1,...}）
        // 和日文短句同样没有空白，却分别是结构化文本和 CJK，
        // 只用「无空白」会把它们误判成编码（实测 tool-result 高估 113%）。
        //
        // 逐块判据（元音占比 / 数字混杂 / 大小写交替）全部试过并否决：
        // base64 会被预分词切成 160 个短碎片，每个碎片都像短英文词，
        // 而 world(元音 0.20) 与 a3f1c2d4(0.17) 在元音维度几乎重叠，
        // 任何阈值都会把 world / brown / jumps 误判成编码。
        // 因此把判定提到「整段」粒度，并加上字符集约束。
        if (!/\s/.test(text) && ENCODED_BLOB_PATTERN.test(text)) {
            const length = text.length;
            // 先排除「单字符/双字符重复串」：BPE 会按固定周期合并，
            // 实测 'a'×40 → 3、'x'×100 → 4（约 len/25），
            // 而编码块的斜率是 0.72/字符，两者差一个数量级。
            if (length > 12 && countDistinctChars(text) <= 2) {
                return Math.max(1, Math.round(length / 25));
            }
            if (length > 12) {
                return Math.max(1, Math.round(length * 0.72));
            }
        }

        let tokens = 0;
        let matchedAny = false;
        const regex = new RegExp(TOKEN_PATTERN_SRC, 'gv');
        let m: RegExpExecArray | null;

        while ((m = regex.exec(text)) !== null) {
            matchedAny = true;
            const match = m[0];
            const trimmed = match.trimStart();
            const len = trimmed.length;
            if (len === 0) {
                // 纯空白：整块计权（不能按字符摊，见 countWhitespaceTokens）
                tokens += countWhitespaceTokens(match);
                continue;
            }

            if (CJK_PATTERN.test(trimmed)) {
                tokens += cjkTokens(trimmed);
            } else if (WS_PATTERN.test(trimmed)) {
                tokens += countWhitespaceTokens(match);
            } else if (DIGIT_PATTERN.test(trimmed)) {
                // 数字块的实测参考值噪声较大（同为 7 位，'1234567'→2、'1000000'→1、
                // '1098765'→3），无法用单一斜率精确拟合。
                // 取 ceil(len/6)：比「每位 1 token」省，比「每 9 位」更贴近真实，
                // 对常见场景（年份 4 位→1、ID 7 位→2、长 ID 12 位→2）是较好的折中。
                tokens += Math.max(1, Math.ceil(len / 6));
            } else if (WORD_PATTERN.test(trimmed)) {
                tokens += wordTokens(trimmed);
            } else {
                tokens += symbolTokens(trimmed);
            }
        }

        if (!matchedAny) return Math.ceil(text.length / 4);
        return Math.max(1, Math.round(tokens));
    } catch (error) {
        // 估算失败必须留痕：静默降级会让 /count_tokens 的数值悄悄变形而无人察觉。
        logger.warn('[TokenUtils] 分词估算失败，回退到 len/4：', getErrorMessage(error));
        return Math.ceil(text.length / 4);
    }
}

/**
 * CJK 字 → token 数（按子集分别标定）。
 * 实测（同一句 31 字）：汉字 1.47/字、片假名 1.52/字、平假名 1.16/字、谚文 1.18/字。
 */
function cjkTokens(text: string): number {
    // CJK 支路每个块就是一个码位，直接用纯每字系数
    // （不能加"每块起步成本"，那会变成每个字都加一次）。
    let ratio = 1.12;
    for (const { pattern, perChar } of CJK_RATIO) {
        if (pattern.test(text)) { ratio = perChar; break; }
    }
    return ratio;
}

/**
 * 非 CJK 字母串 → token 数。
 *
 * 分两种情况，因为 BPE 词表以英文为主，对「像英文的词」和「随机串」的
 * 切分效率差一个数量级：
 *
 *   天然语言词（元音比例正常、无数字混排）
 *     implementation(14) → 1    internationalization(20) → 2
 *     aeiouaeiouaeiouaeiou(20) → 8   ← 元音多但不像词，退化
 *     ref/字符 ≈ 0.07~0.15，按「常见词 1 token，长词约每 7 字符 1 token」
 *
 *   随机串 / 编码（base64、hex、uuid、无元音串）
 *     eyJhbGci...J9(36) → 24   a3f1c2...(32) → 32   xkcdqwr...(24) → 13
 *     ref/字符 ≈ 0.54~1.00，约每 1.5 字符 1 token
 *
 * 判别用元音占比 + 字符多样性（实测均能分开两类）。
 */
function wordTokens(text: string): number {
    for (const { pattern, perByte, extra } of SCRIPT_RATIO) {
        if (pattern.test(text)) {
            // 以 UTF-8 字节为单位：这些文字基本「每 2~3 字节一个子词」，
            // 字节数与 BPE 的切分单位直接对应，比字符数稳得多。
            // extra 是不可压缩的子词起步成本，只加一次。
            return Math.max(1, Math.round(utf8ByteLength(text) * perByte + extra));
        }
    }

    const length = text.length;
    // 单字符/双字符重复串（'aaaa…'、'xxxx…'）：BPE 按固定周期合并，
    // 实测 'a'×40 → 3、'x'×50 → 3、'x'×100 → 4，约 len/25。
    if (length > 8 && countDistinctChars(text) <= 2) {
        return Math.max(1, Math.round(length / 25));
    }

    // 短块（<= 12）：绝大多数是自然语言词或 JSON 键名，记 1 token 最稳。
    //
    // 这里刻意**不**尝试识别 base64 碎片。实测过三条判据（元音占比、
    // 数字混杂度、大小写交替），没有一条能干净区分：
    //   world(0.20) 与 a3f1c2d4(0.17) 的元音占比几乎重叠，
    //   任何阈值都会把 world / brown / jumps 这类正常词打成编码（实测 world→4）。
    // 结果是：base64 类载荷会被低估约 40%，这是本估算器已知的下界，
    // 已在文档与测试中显式登记，不再用错误的启发式去掩盖它。
    if (length <= 12) return 1;

    // 长块才看元音占比：真实英文长词的元音占比都在 40% 以上。
    if (countVowelRatio(text) < 0.25) {
        return Math.max(1, Math.round(length * 0.85));
    }
    // 自然语言长词：按每 5.5 字符切子词
    return Math.ceil(length / 5.5);
}

/** 去重后字符数（用于识别 'aaaa…' 这类重复串） */
function countDistinctChars(text: string): number {
    return new Set(text).size;
}

/** 元音占比（用于区分自然语言词与随机串/编码） */
function countVowelRatio(text: string): number {
    if (!text) return 0;
    let vowels = 0;
    let total = 0;
    for (const char of text.toLowerCase()) {
        const code = char.codePointAt(0) ?? 0;
        // 只对拉丁区间做元音统计；其余文字不参与判别
        if (code > 0x24f) continue;
        total++;
        if (char === 'a' || char === 'e' || char === 'i' || char === 'o' || char === 'u') vowels++;
    }
    return total === 0 ? 1 : vowels / total;
}

/**
 * 符号/标点串 → token 数。
 *
 * 实测：
 *   '!' × N: 1~16→1, 32→2, 64→4, 128→8, 256→16   ≈ max(1, N/16)
 *   emoji 走这一支（它们既非字母也非数字）：实测约 2 token/码位
 *   （👍 → 2，带肤色修饰的 👍🏽 也是 2，ZWJ 家族序列约每码位 2）。
 *   用 UTF-16 长度做分母会把 astral 字符算成 2 个长度单位，
 *   所以这里按**码位**计。
 */
function symbolTokens(text: string): number {
    const codepoints = [...text].length;
    if (codepoints === 0) return 0;
    // 含 emoji / 符号区（>= U+2190 的常见符号与 emoji 起始区）按 2 token/码位
    const firstCode = text.codePointAt(0) ?? 0;
    if (firstCode >= 0x2000) {
        return Math.max(1, Math.round(codepoints * 2));
    }
    return Math.max(1, Math.ceil(codepoints / 16));
}

/**
 * 空白块 → token 数。
 *
 * 实测曲线（真实 Claude BPE）：
 *   ' ' × N (1..1024) → 恒为 1
 *   '\n' × N: 1~32→1, 64→2, 128→4, 256→8          ≈ max(1, N/32)
 *   '\r\n' × N: 1~8→1, 16→2, 32→4, 64→8, 256→32    ≈ max(1, N/16)
 *
 * 旧实现按 ceil(len/4) 逐块计，1000 空格会算成 250（真实 1，误差 +4900%）。
 */
function countWhitespaceTokens(block: string): number {
    if (!block) return 0;
    // 纯空格/制表符：实测 32→1、50→1、100→2、200→2、500→4、1000→5，
    // 拟合为 max(1, round(len/200))，并给 >64 的块补 1（100 与 200 都落在 2）。
    // 整块计权，绝不按字符摊。
    if (!block.includes('\n')) {
        return block.length <= 64 ? 1 : Math.max(2, Math.round(block.length / 200));
    }

    let tokens = 0;
    // 拆成「连续换行段」与「行内空白段」分别计
    const segments = block.match(/\r\n|\n|[^\r\n]+/g) || [];
    let runLength = 0;
    let runIsCrlf = false;

    const flushRun = () => {
        if (runLength === 0) return;
        // CRLF 每段算 2 个字符宽，斜率约为纯 \n 的两倍
        tokens += runIsCrlf
            ? Math.max(1, Math.ceil(runLength / 16))
            : Math.max(1, Math.round(runLength / 30) + (runLength >= 8 ? 1 : 0));
        runLength = 0;
    };

    for (const segment of segments) {
        if (segment === '\r\n') {
            if (runLength > 0 && !runIsCrlf) flushRun();
            runIsCrlf = true;
            runLength += 2;
        } else if (segment === '\n') {
            if (runLength > 0 && runIsCrlf) flushRun();
            runIsCrlf = false;
            runLength += 1;
        } else {
            flushRun();
            // 行内缩进/尾随空格：整块 1 token
            tokens += Math.max(1, Math.round(segment.length / 200));
        }
    }
    flushRun();
    return Math.max(1, tokens);
}

/**
 * Count tokens for a message request (compatible with Anthropic API)
 * @param {Object} requestBody - The request body containing model, messages, system, tools, etc.
 * @returns {Object} { input_tokens: number }
 */
export function countTokensAnthropic(requestBody: UnknownRecord): { input_tokens: number } {
    let allText = "";
    let extraTokens = 0;

    // Count system prompt tokens
    if (requestBody.system) {
        allText += processContent(requestBody.system);
    }

    // Count all messages tokens
    if (requestBody.messages && Array.isArray(requestBody.messages)) {
        for (const message of requestBody.messages) {
            if (isRecord(message) && message.content) {
                if (Array.isArray(message.content)) {
                    for (const block of message.content) {
                        if (!isRecord(block)) {
                            allText += processContent([block]);
                            continue;
                        }
                        if (block.type === 'image') {
                            // Images have a fixed token cost (approximately 1600 tokens for a typical image)
                            extraTokens += 1600;
                        } else if (block.type === 'document') {
                            // Documents - estimate based on content if available
                            const source = isRecord(block.source) ? block.source : null;
                            if (typeof source?.data === 'string') {
                                // For base64 encoded documents, estimate tokens
                                const estimatedChars = source.data.length * 0.75; // base64 to bytes ratio
                                extraTokens += Math.ceil(estimatedChars / 4);
                            }
                        } else {
                            allText += processContent([block]);
                        }
                    }
                } else {
                    allText += processContent(message.content);
                }
            }
        }
    }

    // Count tools definitions tokens if present
    if (requestBody.tools && Array.isArray(requestBody.tools)) {
        allText += JSON.stringify(requestBody.tools);
    }

    return { input_tokens: countTextTokens(allText) + extraTokens };
}
