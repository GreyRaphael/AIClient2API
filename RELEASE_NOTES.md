# AIClient-2-API 发布说明 (v5.0.1)

> **v5.0.1** 是一个修复版本，解决 v5.0.0 中 WebUI `#upload-config` 页面空白的问题。
>
> 后端配置扫描与 `/api/upload-configs` 数据本身正常；问题出在前端 provider 注册表合并时遗漏了 3 个 import，导致渲染配置列表时触发 `ReferenceError`。

---

## 🐛 修复内容

### WebUI `#upload-config` 空白

- `upload-config-manager.js` 补回 `detectProviderFromPath` 导入；
- `file-upload.js` 补回 `getProviderUploadDir` 导入；
- `modal.js` 补回 `isOAuthProvider` 导入。

修复后：

- 配置列表可正常渲染；
- provider 类型过滤、上传目录识别与 OAuth provider 判断恢复正常；
- 其他 provider 与协议行为不变。

---

## ✅ 验证结果

| 项目 | 结果 |
|---|---:|
| 单元测试 | 27 suites / 486 tests |
| TypeScript checkJs | 0 errors |
| 静态语法检查 | 27 / 27 |

---

## 📦 升级建议

- 如果你已使用 v5.0.0 且 WebUI 配置管理页面为空，建议直接升级到 v5.0.1。
- 本次为纯修复版本，无配置或 API 变更。
- 使用 npm 安装依赖：
  ```bash
  npm install
  ```

---

## 📚 相关文档

- [配置分层与优先级](docs/CONFIG_PRECEDENCE.md)
- [跨协议架构](docs/CROSS_PROTOCOL_ARCHITECTURE.md)
- [Provider 适配指南](docs/PROVIDER_ADAPTER_GUIDE.md)
- [E2E 测试说明](tests/e2e/README.md)
