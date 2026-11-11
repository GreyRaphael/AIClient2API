# AIClient-2API 发布说明 (v8.9.0)

> ## 🚀 Node.js 26 架构重构里程碑版本
>
> **版本重点**：全面升级至 Node.js 26 运行时基线与标准库现代特性；存储引擎全面接入原生 `node:sqlite` 并实现事务并发与持久化；架构深度精简，彻底移除冗余插件系统并将「令牌管理」与「模型用量统计」实体化为原生核心模块；WebUI 日历升级为 GitHub 风格全年度热力图与高度自适应排布；新增 Node 26 SEA 单文件打包与 diagnostics_channel 网络诊断套件。

---

## 一、核心变更全景

### 1. 全面升级至 Node.js 26 现代运行时基线与核心语法重构
* **运行时环境**：全面迁移并锁定至 Node 26.x（`engines: >=26.0.0`），启用原生编译缓存（`compileCache`），服务冷启动速度显著提升。
* **标准库现代特性深度迁移**：
  * **Date / Temporal 语法升级**：彻底替换散落的手动日期计算，引入现代日期/时间标准 API，时区计算与统计聚合更精准高效。
  * **正则与字符串**：全面采用原生 `RegExp.escape` 处理动态模型名称、路径与关键词正则转义，消除自定义转义函数的注入风险与维护负担。
  * **集合与迭代器**：全面采用原生 `Array.fromAsync`、`Array.prototype.toReversed`、`toSorted`、`Map.groupBy` 等不可变与流式数据处理语法。
  * **控制流与异常**：利用 `Promise.try` 与现代异步模式收敛全站错误边界与重试逻辑。
  * **现代加密 API**：全面迁移至 `node:crypto` 原生 `randomUUID` 与现代哈希算法。
* **CLI 规范化与参数解析**：基于 `node:util parseArgs` 规范化全站命令行入口与参数解析，彻底告别过时的手动 `process.argv` 字符串切片。

### 2. 存储引擎全面改造：原生 SQLite 与高性能事务保障
* **原生 `node:sqlite`（DatabaseSync）**：
  * 核心服务彻底移除 JSON 文件全量写盘方式，全面迁移至 Node.js 26 内置的高性能 `DatabaseSync`。
  * 令牌管理（Key Manager）与模型用量统计（Usage Stats）均具备 WAL 模式、微秒级读写、行级锁与原子事务隔离能力。
  * 彻底杜绝并发写入时的竞争破坏与进程异常退出时的丢数据风险。

### 3. 架构重大解耦与深度精简（代码净减 4000+ 行）
* **核心模块实体化**：
  * 彻底废除历史包袱繁重、性能税高昂的插件运行时沙盒与远程市场系统。
  * **令牌管理（API Keys / Potluck）**：升格为核心网关服务，支持 1/2/5/10 亿商业化 Token 套餐、有效期管理、并发预扣与多退少补精算。
  * **模型用量统计（Usage Stats）**：升格为核心服务并移入控制台主菜单，流水线内建原子记账，不再依赖外部 hook。
* **第三方依赖极简**：
  * 彻底卸载 `multer` 依赖，基于 Web API 标准流与原生安全检查处理配置与数据导入。
  * 清理过期 JSON 迁移兼容层、过渡期一次性测试及 13 个冗余测试用例，全站架构精干稳定。

### 4. 流式传输背压治理与级联取消
* **多路取消聚合**：利用 `AbortSignal.any` 将客户端断开、超时熔断与主动中断信号级联统一，上游连接毫秒级中断，零配额浪费。
* **背压感知**：流式转发核心全面感知下游写入缓冲区水位，按需等待 `drain` 事件，彻底避免高并发海量流式传输时的内存堆积爆表。

### 5. 原生网络诊断套件与 SEA 单可执行二进制
* **原生网络诊断套件**：
  * 基于 Node.js 26 原生 `diagnostics_channel` 打造端到端轻量网络度量能力，精准追踪 DNS 解析、TCP/TLS 握手、TTFB（首包时延）与完整吞吐。
  * 引入原生 `node:test` 零外部依赖测试套件（`npm run test:node`）。
* **原生 SEA（Single Executable Application）打包**：
  * 新增 `npm run build:sea`，使用 Node 26 官方内置 `--build-sea` 原生机制，一键生成单一独立可执行二进制文件（`bin/aiclient2api`），分发与容器部署即开即用。

### 6. 控制台 WebUI 视觉体验重磅升级
* **GitHub 风格全年度用量热力图**：
  * 算法支持 52~53 周完整自然年网格排布，彻底跳出旧版 3 个月限制，自动从历史中聚合可用年份。
  * 顶部配备年份翻页器与快速 Chip 药丸导航群，并与全局选中过滤双向实时联动。
  * 新增月份周列精准对齐刻度、周一/周三/周五星期标尺与 5 级色度图例。
  * 格子高度充分利用卡片空间自适应拉伸并严格锁定 1:1 正方形（面积提升 3.3 倍以上）。
* **暗黑主题与滚动条细节打磨**：
  * 全局声明 `color-scheme: dark;`，原生控件统一暗色。
  * 重构横向滚动条：完全透明的底轨与纤细圆角深色滑块，解决系统浅色横条发白刺眼问题。
  * 彻底移除亮色主题，保持极简专注的深色沉浸体验。

---

## 二、质量门禁与验证

- **全量门禁检查（npm run verify）全部绿灯通过**：
  1. `typecheck`：TypeScript 主工程零错误
  2. `typecheck:webui`：WebUI 零构建 TypeScript 语法静态类型零错误
  3. `check:strict`：strict 棘轮保持 0 错误基线
  4. `check:any`：0 any 标注 / 0 any 断言
  5. `check:imports`：129 个源文件运行时导入完整性 100% 通过
  6. `check:cycles`：0 循环依赖
  7. `lint:css`：Stylelint CSS 静态校验全部通过
  8. `gen:webui-html:check`：HTML 外壳与真源一致
  9. `vendor:webui:check`：第三方库静态资源同步通过
  10. `test`：**95 个测试套件，982 项测试全部通过**
  11. `test:node`：Node.js 26 原生 `node:test` 网络诊断测试通过
  12. `test:runtime`：原生运行时无转译直接启动冒烟测试通过

---

## 三、升级建议

- **运行时环境要求**：Node.js >= 26.0.0
- **升级步骤**：
  ```bash
  git pull
  npm ci --ignore-scripts
  npm start
  ```
- **配置迁移**：旧版 SQLite 数据库（如 `api-potluck.db` 等）将自动平滑接管，无需手动迁移。

---

**完整变更明细**：见 [CHANGELOG.md](https://github.com/GreyRaphael/AIClient2API/blob/main/CHANGELOG.md)
