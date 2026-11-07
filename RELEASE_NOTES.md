# AIClient-2API 发布说明 (v8.4.0)

> ## ✅ 无破坏性变更。**有两处行为改善需要注意：错误状态码与统计页视图。**

---

## 一、修复：客户端请求错误返回 5xx

以下两类错误本质是「调用方请求不对」，历史上却被兜底成 **500 / 502**：

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 请求不存在的模型（模型名缺 provider 前缀） | **500** | **400** `invalid_request_error` |
| 缺少必填 `messages` | **502**，且先烧掉 **5 次**上游重试 | **400**，**13 ms** 返回 |

第二个更严重：一个必然失败的请求要消耗 5 次上游往返，且朴素重试循环会反复打它。

实现要点：
- 新增 `createClientRequestError()` **显式打标记**，不靠消息文本猜测，真实上游故障仍返回 5xx
- `createErrorResponse` 的状态码解析顺序补齐 `statusCode`（此前只读 `status`/`code`），
  否则错误体里的 `type` 会被错标成 `server_error`
- 在触碰上游之前做本地请求体校验，这是消除 5 次无用重试的关键

## 二、修复：`mergeUsage` 产生 NaN 导致缓存统计恒为 0

`api-potluck` 插件用 `{promptTokens:0, completionTokens:0, totalTokens:0}` 作初始累加器（缺 `cachedTokens`），
`Math.max(undefined, 2534)` 得到 **NaN**，随后污染所有累加、JSON 序列化为 `null`，读回即 0。

现象：插件 `totalCachedTokens` 长期显示 0，而实际命中率约 97.5%。
修复后实测三个 Key 分别记录 **112640 / 71936 / 65792**。

`mergeUsage` 现在对每个字段做有限数值校验，不再信任调用方提供完整对象。

## 三、新增：模型用量统计页支持按天/按模型查看

- `daily[date]` 新增 `models` 子维度（键为 `provider:model`），**扁平字段保留**以兼容历史数据
- **默认展示当日**各模型用量
- **点击日历任意方格**切换到该日视图（选中格高亮）
- 新增 **「历史累计」** 按钮切回全量视图
- 表格新增 **缓存命中率** 列（`cached / prompt`，prompt 为 0 时显示 `—`）

真实浏览器验收：当日 3 个模型命中率 65.20% / 63.84% / 63.50%，历史 138 行，98 个日历格可点击，零控制台错误。

## 四、验证

- 单元测试 **90 suites / 939 tests** 全绿
- `typecheck` / `typecheck:webui` / `check:imports` / `check:cycles` 全部 exit 0
- Playwright 真实浏览器验收通过
