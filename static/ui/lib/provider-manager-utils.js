// Provider Manager 的纯逻辑辅助函数。
// 不依赖 DOM / i18n 全局状态，便于在 Node 测试中直接验证。

export function compareVersions(v1, v2) {
    if (!v1 || !v2) return 0;
    const s1 = v1.replace(/^v/, '').split('.');
    const s2 = v2.replace(/^v/, '').split('.');
    for (let i = 0; i < Math.max(s1.length, s2.length); i++) {
        const n1 = parseInt(s1[i] || 0, 10);
        const n2 = parseInt(s2[i] || 0, 10);
        if (n1 > n2) return 1;
        if (n1 < n2) return -1;
    }
    return 0;
}

export function getCodexExternalImportMeta(source, translate) {
    const examples = {
        cpa: `{
  "type": "codex",
  "account_id": "account-id",
  "email": "user@example.com",
  "id_token": "",
  "access_token": "access-token",
  "refresh_token": "",
  "expired": "2026-05-31T11:40:33.000Z"
}`,
        sub2api: `{
  "exported_at": "2026-05-26T00:29:02Z",
  "accounts": [
    {
      "name": "user@example.com",
      "platform": "openai",
      "credentials": {
        "access_token": "access-token",
        "chatgpt_account_id": "account-id",
        "expires_at": 1780576407,
        "refresh_token": ""
      }
    }
  ]
}`
    };

    return {
        title: translate(source === 'cpa' ? 'oauth.codex.cpaImport' : 'oauth.codex.sub2apiImport'),
        instructions: translate(source === 'cpa' ? 'oauth.codex.cpaImportInstructions' : 'oauth.codex.sub2apiImportInstructions'),
        placeholder: translate(source === 'cpa' ? 'oauth.codex.cpaImportPlaceholder' : 'oauth.codex.sub2apiImportPlaceholder'),
        example: examples[source]
    };
}

export function getCodexExternalImportStats(source, data) {
    if (source === 'sub2api') {
        let accounts = [];
        if (Array.isArray(data)) {
            accounts = data;
        } else if (Array.isArray(data?.accounts)) {
            accounts = data.accounts;
        } else if (data?.credentials && typeof data.credentials === 'object') {
            accounts = [data];
        }
        const openaiAccounts = accounts.filter(account => !account.platform || account.platform === 'openai');
        const validAccounts = openaiAccounts.filter(account => account?.credentials?.access_token);
        return {
            total: accounts.length,
            valid: validAccounts.length,
            skipped: accounts.length - validAccounts.length
        };
    }

    const items = Array.isArray(data) ? data : [data];
    const validItems = items.filter(item => item?.access_token);
    return {
        total: items.length,
        valid: validItems.length,
        skipped: items.length - validItems.length
    };
}
