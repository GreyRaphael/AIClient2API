import {
    polyfillSchemaForGemini,
    polyfillAndCleanSchemaForGemini,
    isSchemaPolyfillEnabled,
    getSchemaPolyfillMaxDesc
} from '../src/converters/schema-polyfill.js';
import { cleanJsonSchemaProperties } from '../src/converters/utils.js';

describe('Schema Polyfill 降级编译器', () => {
    describe('1. $ref 静态内联展开', () => {
        test('展开标准 $defs 引用', () => {
            const schema = {
                $defs: {
                    Address: {
                        type: 'object',
                        properties: {
                            city: { type: 'string' }
                        }
                    }
                },
                type: 'object',
                properties: {
                    shippingAddress: { $ref: '#/$defs/Address' }
                }
            };

            const { schema: result, report } = polyfillSchemaForGemini(schema);
            expect(report.expandedRefs).toBe(1);
            expect(result.$defs).toBeUndefined();
            expect(result.properties.shippingAddress.type).toBe('object');
            expect(result.properties.shippingAddress.properties.city.type).toBe('string');
        });

        test('展开 definitions 引用', () => {
            const schema = {
                definitions: {
                    User: {
                        type: 'object',
                        properties: { name: { type: 'string' } }
                    }
                },
                properties: {
                    user: { $ref: '#/definitions/User' }
                }
            };

            const { schema: result, report } = polyfillSchemaForGemini(schema);
            expect(report.expandedRefs).toBe(1);
            expect(result.definitions).toBeUndefined();
            expect(result.properties.user.properties.name.type).toBe('string');
        });

        test('循环引用检测并安全坍缩', () => {
            const schema = {
                $defs: {
                    Node: {
                        type: 'object',
                        properties: {
                            next: { $ref: '#/$defs/Node' }
                        }
                    }
                },
                properties: {
                    root: { $ref: '#/$defs/Node' }
                }
            };

            const { schema: result, report } = polyfillSchemaForGemini(schema);
            expect(report.expandedRefs).toBeGreaterThanOrEqual(1);
            expect(result.properties.root.type).toBe('object');
            expect(result.properties.root.properties.next.description).toBe('[recursive schema collapsed]');
        });

        test('超深引用超过 maxRefDepth 坍缩', () => {
            const schema = {
                $defs: {
                    Deep: {
                        type: 'object',
                        properties: { child: { $ref: '#/$defs/Deep2' } }
                    },
                    Deep2: {
                        type: 'object',
                        properties: { child: { $ref: '#/$defs/Deep' } }
                    }
                },
                properties: {
                    chain: { $ref: '#/$defs/Deep' }
                }
            };

            const { schema: result } = polyfillSchemaForGemini(schema, { maxRefDepth: 2 });
            expect(result.properties.chain).toBeDefined();
        });

        test('清除根级元字段 $schema, $id', () => {
            const schema = {
                $schema: 'https://json-schema.org/draft/2020-12/schema',
                $id: 'https://example.com/schema.json',
                type: 'object',
                properties: { id: { type: 'number' } }
            };

            const { schema: result } = polyfillSchemaForGemini(schema);
            expect(result.$schema).toBeUndefined();
            expect(result.$id).toBeUndefined();
            expect(result.properties.id.type).toBe('number');
        });
    });

    describe('2. 约束自然语言化注入 (Instruction Injection)', () => {
        test('pattern 与 format 注入格式', () => {
            const schema = {
                type: 'object',
                properties: {
                    itemCode: {
                        type: 'string',
                        pattern: '^[A-Z]{3}-[0-9]{4}$',
                        description: '货品编码'
                    },
                    createdAt: {
                        type: 'string',
                        format: 'date-time'
                    }
                }
            };

            const { schema: result, report } = polyfillSchemaForGemini(schema);
            expect(result.properties.itemCode.description).toBe(
                '货品编码 [Constraints: pattern=^[A-Z]{3}-[0-9]{4}$]'
            );
            expect(result.properties.createdAt.description).toBe(
                '[Constraints: format=date-time]'
            );
            expect(report.injectedConstraints).toHaveLength(2);
        });

        test('数值边界、长度及 items 约束注入', () => {
            const schema = {
                type: 'object',
                properties: {
                    age: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 120,
                        multipleOf: 2
                    },
                    tags: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 10,
                        uniqueItems: true
                    },
                    username: {
                        type: 'string',
                        minLength: 3,
                        maxLength: 20
                    }
                }
            };

            const { schema: result } = polyfillSchemaForGemini(schema);
            expect(result.properties.age.description).toContain('min=1; max=120; multipleOf=2');
            expect(result.properties.tags.description).toContain('minItems=1; maxItems=10; uniqueItems=true');
            expect(result.properties.username.description).toContain('minLength=3; maxLength=20');
        });

        test('default 与 const 注入格式', () => {
            const schema = {
                type: 'object',
                properties: {
                    role: {
                        type: 'string',
                        default: 'viewer'
                    },
                    kind: {
                        type: 'string',
                        const: 'user'
                    }
                }
            };

            const { schema: result } = polyfillSchemaForGemini(schema);
            expect(result.properties.role.description).toContain('default=viewer');
            expect(result.properties.kind.description).toContain('const=user');
        });

        test('单字段注入串超过 200 字符截断', () => {
            const longPattern = '^' + 'A'.repeat(250) + '$';
            const schema = {
                type: 'object',
                properties: {
                    code: {
                        type: 'string',
                        pattern: longPattern
                    }
                }
            };

            const { schema: result } = polyfillSchemaForGemini(schema);
            expect(result.properties.code.description).toContain('...');
            expect(result.properties.code.description.length).toBeLessThan(230);
        });

        test('整 Schema 长度超限时：根级优先裁剪，叶子字段优先保留', () => {
            const schema = {
                type: 'object',
                description: 'Root object',
                pattern: '^[0-9]+$', // 深度 0（根）
                properties: {
                    leaf1: {
                        type: 'string',
                        pattern: '^[a-z]+$', // 深度 1
                        description: 'Leaf 1'
                    },
                    nested: {
                        type: 'object',
                        properties: {
                            leafDeep: {
                                type: 'string',
                                pattern: '^[0-9]{5}$', // 深度 2（叶子）
                                description: 'Deep leaf'
                            }
                        }
                    }
                }
            };

            // 设置极短的描述限制以触发裁剪
            const { schema: result, report } = polyfillSchemaForGemini(schema, { maxDescriptionLength: 90 });
            expect(report.truncated).toBe(true);
            // 根级注入应该被裁剪移除
            expect(result.description).toBe('Root object');
            // 最深的叶子节点优先保留注入
            expect(result.properties.nested.properties.leafDeep.description).toContain('Constraints:');
        });

        test('原始 description 文本永不裁剪', () => {
            const longDesc = 'Original description that is very detailed and important for model understanding. '.repeat(5);
            const schema = {
                type: 'string',
                description: longDesc,
                pattern: '^[a-z]+$'
            };

            const { schema: result } = polyfillSchemaForGemini(schema, { maxDescriptionLength: 50 });
            expect(result.description).toContain(longDesc);
        });
    });

    describe('3. 组合关键字降级 (oneOf / anyOf / allOf)', () => {
        test('oneOf 各分支 type 一致时：保留 type 并注入分支摘要', () => {
            const schema = {
                properties: {
                    status: {
                        oneOf: [
                            { type: 'string', enum: ['draft', 'review'] },
                            { type: 'string', pattern: '^custom-[a-z]+$' }
                        ]
                    }
                }
            };

            const { schema: result, report } = polyfillSchemaForGemini(schema);
            expect(report.collapsedOneOf).toHaveLength(1);
            expect(result.properties.status.type).toBe('string');
            expect(result.properties.status.oneOf).toBeUndefined();
            expect(result.properties.status.description).toContain('[One of:');
            expect(result.properties.status.description).toContain('draft, review');
        });

        test('oneOf 对象分支合并 properties 并保留枚举字段名', () => {
            const schema = {
                type: 'object',
                properties: {
                    shipping: {
                        oneOf: [
                            {
                                type: 'object',
                                properties: { method: { type: 'string', enum: ['standard'] } },
                                required: ['method']
                            },
                            {
                                type: 'object',
                                properties: { method: { type: 'string', enum: ['express'] } },
                                required: ['method']
                            }
                        ]
                    }
                }
            };

            const { schema: result } = polyfillSchemaForGemini(schema);
            const shipping = result.properties.shipping;

            expect(shipping.type).toBe('object');
            expect(shipping.oneOf).toBeUndefined();
            expect(shipping.properties.method.enum).toEqual(['standard', 'express']);
            expect(shipping.required).toContain('method');
        });

        test('oneOf 各分支 type 不一致时：删除 type 字段并注入分支摘要', () => {
            const schema = {
                properties: {
                    value: {
                        oneOf: [
                            { type: 'string', description: 'text value' },
                            { type: 'integer', minimum: 0 }
                        ]
                    }
                }
            };

            const { schema: result, report } = polyfillSchemaForGemini(schema);
            expect(report.collapsedOneOf).toHaveLength(1);
            expect(result.properties.value.type).toBeUndefined();
            expect(result.properties.value.oneOf).toBeUndefined();
            expect(result.properties.value.description).toContain('[One of:');
        });

        test('allOf 浅合并 properties 与 required 并集', () => {
            const schema = {
                type: 'object',
                allOf: [
                    {
                        properties: { a: { type: 'string' } },
                        required: ['a']
                    },
                    {
                        properties: { b: { type: 'number' } },
                        required: ['b']
                    }
                ]
            };

            const { schema: result } = polyfillSchemaForGemini(schema);
            expect(result.allOf).toBeUndefined();
            expect(result.properties.a.type).toBe('string');
            expect(result.properties.b.type).toBe('number');
            expect(result.required).toEqual(expect.arrayContaining(['a', 'b']));
        });
    });

    describe('4. 与 cleanJsonSchemaProperties 串联端到端', () => {
        test('端到端清洗后保留注入的 description 并剔除高级关键字', () => {
            const schema = {
                type: 'object',
                properties: {
                    productId: {
                        type: 'string',
                        pattern: '^[A-Z0-9]{8}$',
                        format: 'alphanumeric',
                        description: 'Product identifier'
                    }
                },
                required: ['productId']
            };

            const cleaned = polyfillAndCleanSchemaForGemini(schema);
            expect(cleaned.properties.productId.pattern).toBeUndefined();
            expect(cleaned.properties.productId.format).toBeUndefined();
            expect(cleaned.properties.productId.description).toContain('Product identifier [Constraints:');
            expect(cleaned.properties.productId.description).toContain('pattern=^[A-Z0-9]{8}$');
        });

        test('CONVERT_SCHEMA_POLYFILL=false 时回退到纯清洗', () => {
            process.env.CONVERT_SCHEMA_POLYFILL = 'false';
            try {
                const schema = {
                    type: 'object',
                    properties: {
                        code: {
                            type: 'string',
                            pattern: '^[0-9]+$',
                            description: 'Pure code'
                        }
                    }
                };
                const cleaned = polyfillAndCleanSchemaForGemini(schema);
                expect(cleaned.properties.code.pattern).toBeUndefined();
                expect(cleaned.properties.code.description).toBe('Pure code');
            } finally {
                delete process.env.CONVERT_SCHEMA_POLYFILL;
            }
        });
    });

    describe('5. 真实 Claude Code 工具集 Fixture 测试', () => {
        test('Claude Code Edit / Write 工具 schema polyfill', () => {
            const claudeEditToolSchema = {
                $schema: 'http://json-schema.org/draft-07/schema#',
                type: 'object',
                properties: {
                    file_path: {
                        type: 'string',
                        description: 'The absolute path to the file to modify'
                    },
                    edits: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                old_string: {
                                    type: 'string',
                                    description: 'The text to replace'
                                },
                                new_string: {
                                    type: 'string',
                                    description: 'The replacement text'
                                }
                            },
                            required: ['old_string', 'new_string']
                        }
                    },
                    command: {
                        description: 'Action command',
                        oneOf: [
                            { type: 'string', enum: ['replace', 'insert'] },
                            { type: 'string', pattern: '^custom_.*$' }
                        ]
                    }
                },
                required: ['file_path', 'edits']
            };

            const cleaned = polyfillAndCleanSchemaForGemini(claudeEditToolSchema);
            expect(cleaned.$schema).toBeUndefined();
            expect(cleaned.properties.file_path.type).toBe('STRING');
            expect(cleaned.properties.edits.type).toBe('ARRAY');
            expect(cleaned.properties.command.type).toBe('STRING');
            expect(cleaned.properties.command.oneOf).toBeUndefined();
            expect(cleaned.properties.command.description).toContain('[One of:');
            expect(cleaned.properties.command.description).toContain('replace, insert');
        });

        test('带复杂 $defs 联合与正则约束的 Agent 工具 schema', () => {
            const complexAgentTool = {
                $defs: {
                    FileRef: {
                        type: 'object',
                        properties: {
                            uri: { type: 'string', format: 'uri' },
                            line: { type: 'integer', minimum: 1 }
                        },
                        required: ['uri']
                    }
                },
                type: 'object',
                properties: {
                    target: { $ref: '#/$defs/FileRef' },
                    filter: {
                        type: 'string',
                        pattern: '^[a-zA-Z0-9_-]+$',
                        maxLength: 50
                    }
                },
                required: ['target']
            };

            const cleaned = polyfillAndCleanSchemaForGemini(complexAgentTool);
            expect(cleaned.$defs).toBeUndefined();
            expect(cleaned.properties.target.type).toBe('OBJECT');
            expect(cleaned.properties.target.properties.uri.description).toContain('format=uri');
            expect(cleaned.properties.target.properties.line.description).toContain('min=1');
            expect(cleaned.properties.filter.description).toContain('pattern=^[a-zA-Z0-9_-]+$; maxLength=50');
        });
    });

    describe('6. dialect 预留接口', () => {
        const constraintSchema = {
            type: 'object',
            properties: {
                code: { type: 'string', pattern: '^[A-Z]{3}-[0-9]{4}$', minLength: 8 }
            }
        };

        test("默认 dialect 为 'gemini'，显式传 'gemini' 行为一致", () => {
            const { schema: base, report: baseReport } = polyfillSchemaForGemini(constraintSchema);
            const { schema: explicit, report: explicitReport } = polyfillSchemaForGemini(constraintSchema, { dialect: 'gemini' });
            expect(explicit).toEqual(base);
            expect(explicitReport).toEqual(baseReport);
        });
    });
});
