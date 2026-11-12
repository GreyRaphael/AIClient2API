# AIClient-2API 发布说明 (v8.9.0)

> ## 🚀 Node.js 26 架构重构里程碑版本
>
> **版本重点**：全面升级至 Node.js 26 运行时基线与标准库现代特性；存储引擎全面接入原生 `node:sqlite` 并实现事务并发与持久化；架构深度精简，彻底移除冗余插件系统并将「令牌管理」与「模型用量统计」实体化为原生核心模块；WebUI 日历升级为 GitHub 风格全年度热力图与高度自适应排布；新增 diagnostics_channel 网络诊断套件。

---

## ⚠️ 破坏性变更（升级前必读）

> 本版本**不提供向后兼容，也不提供数据迁移**。以下能力与数据入口均已删除。

1. **运行时基线收紧至 Node.js 26+**：`engines` 由 `>=24.0.0` 上调为 `>=26.0.0`，
   Node 24 及更早版本启动即退出。本版本直接运行 `.ts` 源码，依赖原生类型擦除。
2. **插件系统已彻底移除**：`src/plugins/`、`src/plugins-user/`、插件市场、
   插件运行时沙箱、安装期静态扫描全部删除；`configs/plugins.json` 不再被读取。
   原能力由核心模块承接：**令牌管理**（`src/services/api-keys/`）与
   **模型用量统计**（`src/services/usage-stats/`）。
3. **存储由 JSON 切换为 `node:sqlite`，且不迁移旧数据**：
   `configs/api-potluck-keys.json`、`configs/api-potluck-data.json`、
   `configs/model-usage-stats.json`、`configs/usage-cache.json` 不再被读取。
   升级需**重新创建令牌与统计**（用量缓存会自动重建）。
4. **亮色主题已移除**：仅支持暗色主题。
5. **插件管理接口全部移除**（返回 404）：`GET /api/plugins`、`GET /api/plugins/market`、
   `POST /api/plugins/install`、`POST /api/plugins/upload`、
   `POST /api/plugins/:name/toggle`、`DELETE /api/plugins/:name`。
6. **移除的 npm script / 工具**：`typecheck:plugins`（`tsconfig.plugins.json`、
   `types/plugin.d.ts` 一并删除）、`build:sea`（`scripts/build-sea.mjs` 删除）、
   覆盖率门禁（`check:coverage` / `test:coverage` / `coverage:update` 及相关脚本删除）。

---

## 一、核心变更全景

### 1. 全面升级至 Node.js 26 现代运行时基线与核心语法重构
* **运行时环境**：全面迁移并锁定至 Node 26.x（`engines: >=26.0.0`），启用原生编译缓存（`enableCompileCache`），服务冷启动速度显著提升。
* **标准库现代特性迁移**（仅列本版本**实际采用**的 API）：
  * **Temporal**：替代散落的手动日期计算，时区换算与统计聚合不再依赖手工偏移量。
  * **集合与迭代器**：采用 `Array.fromAsync`、`Array.prototype.toSorted`、`Object.groupBy`、`structuredClone` 等不可变与流式数据处理语法。
  * **加密**：统一使用 `node:crypto` 的 `randomUUID` 生成标识。
* **CLI 规范化与参数解析**：基于 `node:util parseArgs` 规范化全站命令行入口与参数解析，彻底告别过时的手动 `process.argv` 字符串切片。

### 2. 存储引擎全面改造：原生 SQLite 与事务保障
* **原生 `node:sqlite`（DatabaseSync）**：
  * 核心服务彻底移除 JSON 文件全量写盘方式，全面迁移至 Node.js 26 内置的 `DatabaseSync`。
  * 令牌管理与模型用量统计均启用 WAL 模式（`journal_mode = WAL`）、
    `BEGIN IMMEDIATE` 写事务与 `busy_timeout`，具备原子事务隔离能力。
  * 消除并发写入时的部分写与进程异常退出时的丢数据风险（写入走事务提交，不再整文件覆写）。

### 3. 架构重大解耦与深度精简（仓库净减约 1 万行）
* **核心模块实体化**：
  * 彻底废除历史包袱繁重、性能税高昂的插件运行时沙盒与远程市场系统。
  * **令牌管理（API Keys / Potluck）**：升格为核心网关服务，支持 1/2/5/10 亿商业化 Token 套餐、有效期管理、并发预扣与多退少补精算。
  * **模型用量统计（Usage Stats）**：升格为核心服务并移入控制台主菜单，流水线内建原子记账，不再依赖外部 hook。
* **第三方依赖极简**：
  * 彻底卸载 `multer` 依赖，基于 Web API 标准流与原生安全检查处理配置与数据导入。
  * 清理过期 JSON 迁移兼容层与 16 个过期测试文件（`src/` 自身净减 751 行，
    全仓库净减约 1 万行），全站架构精干稳定。

### 4. 流式传输背压治理与级联取消
* **多路取消聚合**：利用 `AbortSignal.any` 将客户端断开与主动中断信号级联统一，上游连接在客户端断连时立即中断，零配额浪费。
* **背压感知**：流式转发核心全面感知下游写入缓冲区水位，按需等待 `drain` 事件，彻底避免高并发海量流式传输时的内存堆积爆表。

### 5. 原生网络诊断套件
* **原生网络诊断套件**：
  * 基于 Node.js 26 原生 `diagnostics_channel` 打造端到端轻量网络度量能力，追踪 TTFB（首包时延）与完整吞吐。
  * 测试套件全量迁移到原生 `node:test`（`npm test`），零外部测试依赖。

### 6. 控制台 WebUI 视觉体验重磅升级
* **GitHub 风格全年度用量热力图**：
  * 算法支持 53~54 周完整自然年网格排布，彻底跳出旧版 3 个月限制，自动从历史中聚合可用年份。
  * 顶部配备年份翻页器与快速 Chip 药丸导航群，并与全局选中过滤双向实时联动。
  * 新增月份刻度、周一/周三/周五星期标尺与 5 级色度图例。
  * 格子高度充分利用卡片空间自适应拉伸并锁定 1:1 正方形（单格由固定 11px 变为
    自适应 14~26px，面积约为原来的 1.6~5.6 倍，随卡片高度增长）。
* **暗黑主题与滚动条细节打磨**：
  * 全局声明 `color-scheme: dark;`，原生控件统一暗色。
  * 重构横向滚动条：完全透明的底轨与纤细圆角深色滑块，解决系统浅色横条发白刺眼问题。
  * 彻底移除亮色主题，保持极简专注的深色沉浸体验。

---

## 二、质量门禁与验证

- **`npm run verify` 串联以下 11 个步骤**，覆盖类型、棘轮、依赖图与测试四类约束：

  1. `typecheck`：TypeScript 主工程零错误
  2. `typecheck:webui`：WebUI 零构建 TypeScript 语法静态类型零错误
  3. `check:strict`：strict 棘轮保持 0 错误基线
  4. `check:any`：0 any 标注 / 0 any 断言
  5. `check:imports`：133 个源文件运行时导入完整性 100% 通过
  6. `check:cycles`：0 循环依赖
  7. `lint:css`：Stylelint CSS 静态校验全部通过
  8. `gen:webui-html:check`：HTML 外壳与真源一致
  9. `vendor:webui:check`：第三方库静态资源同步通过
  10. `test`：1098 项测试全绿（Node 26 原生 `node:test`）
  11. `test:runtime`：原生运行时无转译直接启动冒烟测试

> **说明**：测试运行器已由 Jest 全量迁移到 Node 26 原生 `node:test`，
> 原来的 `test:node` 独立脚本已并入 `npm test`（该脚本已删除，
> CI 里的同名步骤也已移除）。
> **本版本不提供覆盖率门禁**：`check:coverage` / `coverage:update` 及相关脚本
> 均不存在。覆盖率只能证明「测试没被删」，证明不了「测试写得对」——
> 本轮修复的 14 个缺陷全部落在有覆盖的代码里，覆盖率对其无一有效。
> SEA 打包同样已整体移除。

---

## 三、升级建议

- **运行时环境要求**：Node.js >= 26.0.0
- **⚠️ 本版本不提供数据迁移**：存储已从 JSON 切换为 `node:sqlite`，
  `configs/api-potluck-keys.json`、`configs/api-potluck-data.json`、
  `configs/model-usage-stats.json`、`configs/usage-cache.json` 不再被读取。
  从 8.8.x 升级需**重新创建令牌与统计**（用量缓存自动重建）；
  旧 JSON 文件可自行留档或删除。
- **插件系统已移除**：`src/plugins-user/`、`configs/plugins.json` 与 `/api/plugins/*`
  接口均已删除，原插件能力由核心的令牌管理与模型用量统计模块承接。
- **仅支持暗色主题**：亮色主题已移除。
- **升级步骤**：
  ```bash
  git pull
  npm ci --ignore-scripts
  npm start
  ```

---

**完整变更明细**：见 [CHANGELOG.md](https://github.com/GreyRaphael/AIClient2API/blob/main/CHANGELOG.md)
