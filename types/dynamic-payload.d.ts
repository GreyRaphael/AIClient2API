/**
 * 全局共享的动态载荷别名。
 *
 * 迁移期各模块曾各自复制 `type DynamicPayload = Record<string, any>`。
 * 这里保留唯一声明，作为受控的动态边界；新增使用仍受 any 棘轮约束。
 */
export type DynamicPayload = Record<string, any>;
