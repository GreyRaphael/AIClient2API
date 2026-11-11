/**
 * 运行环境探测（是否为自动化测试进程）。
 *
 * 单测需要 import 生产模块来验证纯函数，但绝不能触发真实副作用
 * （监听端口、fork worker、启动定时器、落盘）。
 *
 * 判据只认 Node.js 官方注入的 `NODE_TEST_CONTEXT`：`node --test` 在每个测试子进程里
 * 设为 'child-v8' / 'child' 等值，生产环境不可能出现该变量。
 *
 * 刻意**不**判断 `NODE_ENV === 'test'`：部署时用户完全可能把它设成 test，
 * 那会让后台刷新静默停摆、主进程不启动 —— 等于网关整体下线。
 */
export function isTestEnv(): boolean {
    return process.env.NODE_TEST_CONTEXT !== undefined;
}
