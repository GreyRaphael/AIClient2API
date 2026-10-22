// @ts-check
import logger from '../utils/logger.js';
import { cleanJsonSchemaProperties } from './utils.js';
import { getConfigToggle, getConfigPositiveInt } from '../core/config-manager.js';

/**
 * 判断 Schema Polyfill 是否启用（默认启用）
 * @returns {boolean}
 */
export function isSchemaPolyfillEnabled() {
    return getConfigToggle('CONVERT_SCHEMA_POLYFILL', true);
}

/**
 * 获取 Schema Polyfill 单 Schema 描述总长度上限（默认 1000 字符）
 * @returns {number}
 */
export function getSchemaPolyfillMaxDesc() {
    return getConfigPositiveInt('CONVERT_SCHEMA_POLYFILL_MAX_DESC', 1000);
}

/**
 * 深拷贝辅助函数
 * @param {any} obj
 * @returns {any}
 */
function deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(deepClone);
    const copy = {};
    for (const key of Object.keys(obj)) {
        copy[key] = deepClone(obj[key]);
    }
    return copy;
}

/**
 * 解码 JSON Pointer 片段 (~1 -> /, ~0 -> ~)
 * @param {string} part
 * @returns {string}
 */
function decodeJsonPointerPart(part) {
    return part.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * 在根 Schema 中根据 JSON Pointer 解析目标对象
 * @param {Object} rootSchema
 * @param {string} ref
 * @returns {any}
 */
function resolveRef(rootSchema, ref) {
    if (!ref.startsWith('#/')) return undefined;
    const parts = ref.slice(2).split('/').map(decodeJsonPointerPart);
    let curr = rootSchema;
    for (const part of parts) {
        if (curr && typeof curr === 'object' && part in curr) {
            curr = curr[part];
        } else {
            return undefined;
        }
    }
    return curr;
}

/**
 * 工具 Schema Polyfill 降级编译器
 * 
 * 将高级 JSON Schema 特性（$ref, oneOf, anyOf, allOf, pattern, format, 数值边界等）
 * 降级编译为 Gemini / Trae Protobuf 解析器兼容的纯净 Schema，并通过自然语言将校验约束注入 description。
 * 
 * @param {Object} rawSchema - 原始 JSON Schema
 * @param {Object} [options={}] - 配置选项
 * @param {boolean} [options.injectConstraints=true] - 是否自然语言化注入约束
 * @param {number} [options.maxDescriptionLength=1000] - 整 schema description 总量字符上限
 * @param {number} [options.maxRefDepth=10] - $ref 展开最大嵌套深度
 * @param {'gemini'|'trae'} [options.dialect='gemini'] - 目标方言（预留接口：Trae 通道本期不接入，行为同 'gemini'）
 * @returns {{ schema: Object, report: { expandedRefs: number, injectedConstraints: Array<{path: string, kinds: string[]}>, collapsedOneOf: Array<{path: string}>, truncated: boolean } }}
 */
export function polyfillSchemaForGemini(rawSchema, options = {}) {
    const injectConstraints = options.injectConstraints !== false;
    const maxDescriptionLength = (typeof options.maxDescriptionLength === 'number' && options.maxDescriptionLength > 0)
        ? options.maxDescriptionLength
        : getSchemaPolyfillMaxDesc();
    const maxRefDepth = (typeof options.maxRefDepth === 'number' && options.maxRefDepth > 0) ? options.maxRefDepth : 10;
    // dialect 预留接口：Trae 通道（trae-core.js parameters 字符串化处）本期不接入，
    // 两种方言当前行为一致；显式传入 'trae' 时记录一次 debug 便于观测未来接入点。
    const dialect = options.dialect === 'trae' ? 'trae' : 'gemini';
    if (dialect === 'trae') {
        logger.debug("[SchemaPolyfill] dialect='trae' is a reserved interface; Trae channel is not integrated yet, behaving as 'gemini'");
    }

    const report = {
        expandedRefs: 0,
        injectedConstraints: [],
        collapsedOneOf: [],
        truncated: false
    };

    if (!rawSchema || typeof rawSchema !== 'object' || Array.isArray(rawSchema)) {
        return { schema: deepClone(rawSchema), report };
    }

    const rootCopy = deepClone(rawSchema);
    /** @type {Array<{ node: Object, originalDesc: string|undefined, injectedText: string, depth: number }>} */
    const injectedNodes = [];

    // =========================================================================
    // 阶段 1 & 2 & 3 递归遍历与编译
    // =========================================================================
    function transformNode(node, path = '#', depth = 0, refStack = []) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) {
            return node;
        }

        // 1. $ref 静态内联展开
        if (node.$ref && typeof node.$ref === 'string') {
            const ref = node.$ref;
            if (refStack.includes(ref) || depth >= maxRefDepth) {
                // 循环引用检测或深度超限，坍缩为安全对象
                delete node.$ref;
                node.type = 'object';
                node.description = '[recursive schema collapsed]';
                report.expandedRefs++;
                return node;
            }

            const resolvedTarget = resolveRef(rootCopy, ref);
            if (resolvedTarget && typeof resolvedTarget === 'object') {
                report.expandedRefs++;
                const clonedTarget = deepClone(resolvedTarget);
                // 递归展开解析出的子 Schema
                const expanded = transformNode(clonedTarget, path, depth + 1, [...refStack, ref]);
                // 保留当前节点已有属性并合并
                delete node.$ref;
                Object.assign(node, { ...expanded, ...node });
            }
        }

        // 递归处理子属性与子元素
        if (node.properties && typeof node.properties === 'object') {
            for (const propName of Object.keys(node.properties)) {
                node.properties[propName] = transformNode(
                    node.properties[propName],
                    `${path}/properties/${propName}`,
                    depth + 1,
                    refStack
                );
            }
        }

        if (node.items) {
            if (Array.isArray(node.items)) {
                node.items = node.items.map((item, idx) =>
                    transformNode(item, `${path}/items/${idx}`, depth + 1, refStack)
                );
            } else if (typeof node.items === 'object') {
                node.items = transformNode(node.items, `${path}/items`, depth + 1, refStack);
            }
        }

        if (node.patternProperties && typeof node.patternProperties === 'object') {
            for (const pat of Object.keys(node.patternProperties)) {
                node.patternProperties[pat] = transformNode(
                    node.patternProperties[pat],
                    `${path}/patternProperties/${pat}`,
                    depth + 1,
                    refStack
                );
            }
        }

        // 3. 组合关键字降级：allOf 浅合并
        if (Array.isArray(node.allOf) && node.allOf.length > 0) {
            node.properties = node.properties || {};
            node.required = node.required || [];

            for (const branch of node.allOf) {
                if (branch && typeof branch === 'object') {
                    const transformedBranch = transformNode(branch, `${path}/allOf`, depth + 1, refStack);
                    if (transformedBranch.properties) {
                        Object.assign(node.properties, transformedBranch.properties);
                    }
                    if (Array.isArray(transformedBranch.required)) {
                        node.required = Array.from(new Set([...node.required, ...transformedBranch.required]));
                    }
                    if (!node.description && transformedBranch.description) {
                        node.description = transformedBranch.description;
                    }
                }
            }
            if (node.required.length === 0) {
                delete node.required;
            }
            delete node.allOf;
        }

        // 3. 组合关键字降级：oneOf / anyOf
        const unionBranches = Array.isArray(node.oneOf) ? node.oneOf : (Array.isArray(node.anyOf) ? node.anyOf : null);
        if (unionBranches && unionBranches.length > 0) {
            report.collapsedOneOf.push({ path });

            const transformedBranches = unionBranches.map((b, idx) =>
                transformNode(b, `${path}/oneOf/${idx}`, depth + 1, refStack)
            );

            // 检查各分支类型是否一致
            const branchTypes = transformedBranches.map(b => b.type).filter(Boolean);
            const allSameType = branchTypes.length === transformedBranches.length && new Set(branchTypes).size === 1;

            if (allSameType) {
                node.type = branchTypes[0];
            } else {
                delete node.type;
            }

            // oneOf/anyOf 的对象分支：合并 properties 以保留字段名与枚举，
            // 但 required 取各分支交集，避免把某个互斥分支的必填字段强加到所有分支。
            if (allSameType && branchTypes[0] === 'object') {
                const mergedProperties = {};
                const requiredSets = transformedBranches.map(
                    (branch) => new Set(Array.isArray(branch.required) ? branch.required : [])
                );

                for (const branch of transformedBranches) {
                    if (branch.properties && typeof branch.properties === 'object') {
                        for (const [key, value] of Object.entries(branch.properties)) {
                            const existing = mergedProperties[key];
                            if (!existing) {
                                mergedProperties[key] = value;
                            } else if (Array.isArray(existing.enum) && Array.isArray(value.enum)) {
                                mergedProperties[key] = {
                                    ...existing,
                                    ...value,
                                    enum: Array.from(new Set([...existing.enum, ...value.enum]))
                                };
                            } else {
                                mergedProperties[key] = { ...existing, ...value };
                            }
                        }
                    }
                }

                if (Object.keys(mergedProperties).length > 0) {
                    node.properties = {
                        ...(node.properties || {}),
                        ...mergedProperties
                    };
                    const commonRequired = requiredSets.length > 0
                        ? [...requiredSets[0]].filter((key) => requiredSets.every((set) => set.has(key)))
                        : [];
                    node.required = Array.from(new Set([
                        ...(Array.isArray(node.required) ? node.required : []),
                        ...commonRequired
                    ]));
                    if (node.required.length === 0) {
                        delete node.required;
                    }
                }
            }

            // 构造分支摘要（截断 120 字符）
            const branchSummaries = transformedBranches.map(b => {
                if (Array.isArray(b.enum) && b.enum.length > 0) {
                    const preview = b.enum.slice(0, 4).join(', ');
                    return `enum[${preview}${b.enum.length > 4 ? ', ...' : ''}]`;
                }
                if (b.const !== undefined) {
                    return `const=${typeof b.const === 'object' ? JSON.stringify(b.const) : b.const}`;
                }
                const t = b.type || 'any';
                if (b.pattern) {
                    return `${t}(pattern=${b.pattern})`;
                }
                if (b.format) {
                    return `${t}(format=${b.format})`;
                }
                if (b.description) {
                    return `${t}(${b.description})`;
                }
                return t;
            });

            let unionSummary = branchSummaries.join(' | ');
            if (unionSummary.length > 120) {
                unionSummary = unionSummary.slice(0, 117) + '...';
            }

            const oneOfText = `[One of: ${unionSummary}]`;
            node.description = node.description ? `${node.description} ${oneOfText}` : oneOfText;

            delete node.oneOf;
            delete node.anyOf;
        }

        // 2. 约束自然语言化注入 (Instruction Injection Polyfill)
        if (injectConstraints) {
            const constraintItems = [];
            const kinds = [];

            // Gemini 只接受字符串 enum；数值/布尔 enum 会被白名单清洗丢弃，
            // 因此在降级前把原始 enum 注入 description，保留约束语义。
            if (Array.isArray(node.enum) && node.enum.some((value) => typeof value !== 'string')) {
                constraintItems.push(`enum=${node.enum.map((value) => JSON.stringify(value)).join('|')}`);
                kinds.push('enum');
            }

            if (node.pattern) {
                constraintItems.push(`pattern=${node.pattern}`);
                kinds.push('pattern');
            }
            if (node.format) {
                constraintItems.push(`format=${node.format}`);
                kinds.push('format');
            }
            if (node.default !== undefined) {
                constraintItems.push(`default=${typeof node.default === 'object' ? JSON.stringify(node.default) : node.default}`);
                kinds.push('default');
            }
            if (node.const !== undefined) {
                constraintItems.push(`const=${typeof node.const === 'object' ? JSON.stringify(node.const) : node.const}`);
                kinds.push('const');
            }
            if (node.minimum !== undefined) {
                constraintItems.push(`min=${node.minimum}`);
                kinds.push('minimum');
            }
            if (node.maximum !== undefined) {
                constraintItems.push(`max=${node.maximum}`);
                kinds.push('maximum');
            }
            if (node.exclusiveMinimum !== undefined) {
                constraintItems.push(`exclusiveMin=${node.exclusiveMinimum}`);
                kinds.push('exclusiveMinimum');
            }
            if (node.exclusiveMaximum !== undefined) {
                constraintItems.push(`exclusiveMax=${node.exclusiveMaximum}`);
                kinds.push('exclusiveMaximum');
            }
            if (node.minLength !== undefined) {
                constraintItems.push(`minLength=${node.minLength}`);
                kinds.push('minLength');
            }
            if (node.maxLength !== undefined) {
                constraintItems.push(`maxLength=${node.maxLength}`);
                kinds.push('maxLength');
            }
            if (node.minItems !== undefined) {
                constraintItems.push(`minItems=${node.minItems}`);
                kinds.push('minItems');
            }
            if (node.maxItems !== undefined) {
                constraintItems.push(`maxItems=${node.maxItems}`);
                kinds.push('maxItems');
            }
            if (node.uniqueItems) {
                constraintItems.push('uniqueItems=true');
                kinds.push('uniqueItems');
            }
            if (node.multipleOf !== undefined) {
                constraintItems.push(`multipleOf=${node.multipleOf}`);
                kinds.push('multipleOf');
            }

            if (constraintItems.length > 0) {
                let joinedConstraints = constraintItems.join('; ');
                // 单字段注入串上限 200 字符
                if (joinedConstraints.length > 200) {
                    joinedConstraints = joinedConstraints.slice(0, 197) + '...';
                }

                const originalDesc = node.description;
                const injection = `[Constraints: ${joinedConstraints}]`;
                const newDesc = originalDesc ? `${originalDesc} ${injection}` : injection;

                node.description = newDesc;
                report.injectedConstraints.push({ path, kinds });
                injectedNodes.push({
                    node,
                    originalDesc,
                    injectedText: originalDesc ? ` ${injection}` : injection,
                    depth
                });
            }
        }

        return node;
    }

    // 执行转换
    const polyfilled = transformNode(rootCopy);

    // 剥离根级定义与 Schema 元关键字
    if (polyfilled && typeof polyfilled === 'object') {
        delete polyfilled.$defs;
        delete polyfilled.definitions;
        delete polyfilled.$schema;
        delete polyfilled.$id;
    }

    // =========================================================================
    // 阶段 2 长度控制：叶子优先保留、根级/浅层优先裁剪
    // =========================================================================
    if (injectConstraints && injectedNodes.length > 0) {
        // 计算整 Schema 当前 description 总字符量
        let totalDescLength = 0;
        function countDescLength(node) {
            if (!node || typeof node !== 'object') return;
            if (typeof node.description === 'string') {
                totalDescLength += node.description.length;
            }
            if (node.properties && typeof node.properties === 'object') {
                for (const k of Object.keys(node.properties)) {
                    countDescLength(node.properties[k]);
                }
            }
            if (node.items) {
                if (Array.isArray(node.items)) node.items.forEach(countDescLength);
                else countDescLength(node.items);
            }
        }
        countDescLength(polyfilled);

        if (totalDescLength > maxDescriptionLength) {
            report.truncated = true;
            logger.debug(`[SchemaPolyfill] Total description length (${totalDescLength}) exceeds maxDescriptionLength (${maxDescriptionLength}), trimming shallow nodes`);

            // 按深度升序排序（深度小的在前面，先裁剪根级与顶层属性）
            injectedNodes.sort((a, b) => a.depth - b.depth);

            for (const item of injectedNodes) {
                if (totalDescLength <= maxDescriptionLength) break;

                // 还原原始描述，移除注入部分
                if (item.originalDesc !== undefined) {
                    item.node.description = item.originalDesc;
                } else {
                    delete item.node.description;
                }
                totalDescLength -= item.injectedText.length;
            }
        }
    }

    return { schema: polyfilled, report };
}

/**
 * 组合 Polyfill 与标准白名单清洗
 * 供 OpenAIConverter 及 Gemini provider 调用点前置复用
 * 
 * @param {Object} schema - 原始 Schema
 * @param {Object} [options={}] - Polyfill 参数
 * @returns {Object} 清理后的 JSON Schema
 */
export function polyfillAndCleanSchemaForGemini(schema, options = {}) {
    if (!schema || typeof schema !== 'object') {
        return cleanJsonSchemaProperties(schema);
    }
    if (!isSchemaPolyfillEnabled()) {
        return cleanJsonSchemaProperties(schema);
    }
    const { schema: polyfilled } = polyfillSchemaForGemini(schema, options);
    return cleanJsonSchemaProperties(polyfilled);
}
