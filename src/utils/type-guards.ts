/**
 * 通用类型守卫。
 *
 * 这些函数此前被逐个文件复制：`isRecord` 全仓有 15 份，其中 14 份函数体逐字相同。
 * 复制本身无害，但它们的**语义分歧**有害 —— 有 1 份带 `!Array.isArray()`、13 份不带，
 * 于是调用方无法确定 `isRecord([])` 到底返回什么，跨文件搬运代码时会静默改变行为。
 * 这里给出两个语义明确的守卫，其余各处只允许 import 这两个之一。
 */

/** 任何非 null 的对象（**包含数组**）。用于「能不能安全读属性」的判断。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}

/** 纯对象：非 null、非数组。用于「这是不是一个 JSON 对象」的判断。 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
