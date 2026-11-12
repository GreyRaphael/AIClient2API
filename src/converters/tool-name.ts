/**
 * 工具名缩短：上游对工具名有 64 字符上限，超长必须截断。
 *
 * 这里集中放**唯一实现**。历史上这段算法被复制了 5 份
 * （codex-core / CodexConverter ×2 / ClaudeConverter ×2），其中 ClaudeConverter 那份
 * **漏掉了内容哈希后缀**，直接 `name.slice(0, limit)`，导致两个长前缀相同、尾部不同的
 * 工具被截成**完全相同**的名字 —— Codex 侧按短名反查原名时就无法区分，调用会串到
 * 错误的工具上。因此正确性关键在「截断必须带内容哈希」这一点上，
 * 只有一份实现才能保证它不会被再次漏掉。
 */

import { hash } from 'node:crypto';

/** 上游（Codex / Anthropic tools 数组）接受的工具名长度上限。 */
export const TOOL_NAME_LIMIT = 64;

/** 截断后追加的内容哈希长度（hex 字符数）。 */
const HASH_SUFFIX_LENGTH = 16;

/**
 * 把任意工具名压到 `TOOL_NAME_LIMIT` 以内，并保证不同名字不会碰撞。
 *
 * 规则：
 * 1. 不超长直接返回；
 * 2. `mcp__<server>__<tool>` 形态优先保留协议前缀与最后一段（可读性最好）；
 * 3. 其余情况在截断处追加由**完整原名**算出的 sha256 前缀，
 *    因此「同前缀不同尾部」的名字依然互不相同。
 */
export function shortenToolName(name: string): string {
    if (typeof name !== 'string' || name.length <= TOOL_NAME_LIMIT) return name;

    if (name.startsWith('mcp__')) {
        const lastSeparator = name.lastIndexOf('__');
        if (lastSeparator > 0) {
            const mcpCandidate = `mcp__${name.slice(lastSeparator + 2)}`;
            return mcpCandidate.length > TOOL_NAME_LIMIT
                ? mcpCandidate.slice(0, TOOL_NAME_LIMIT)
                : mcpCandidate;
        }
    }

    const suffix = `_${hash('sha256', name, 'hex').slice(0, HASH_SUFFIX_LENGTH)}`;
    return name.slice(0, TOOL_NAME_LIMIT - suffix.length) + suffix;
}

/**
 * 为一组工具名构建「原名 → 短名」映射，并保证表内短名两两不同。
 *
 * `shortenToolName` 保证「不同原名得到不同短名」，但当两个原名本就极短且相同
 * （上游重复声明同一工具）时仍是同一个短名；反向映射需要唯一性，
 * 故这里对重复短名追加 `_1` / `_2` 序号。返回的 map 可直接用于响应侧反查。
 */
export function buildToolNameMap(names: readonly string[]): Record<string, string> {
    const map: Record<string, string> = {};
    const used = new Set<string>();

    const unique = (candidate: string): string => {
        if (!used.has(candidate)) return candidate;
        for (let index = 1; ; index += 1) {
            const suffixed = `${candidate}_${index}`;
            if (!used.has(suffixed)) return suffixed;
        }
    };

    for (const name of names) {
        if (typeof name !== 'string' || !name) continue;
        const shortened = unique(shortenToolName(name));
        used.add(shortened);
        map[name] = shortened;
    }
    return map;
}
