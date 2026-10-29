import { describe, test, expect } from '@jest/globals';
import {
    mergeAwsCredentialFiles,
    normalizeAwsCredentials,
    redactAwsCredentials,
    validateAwsCredentials
} from '@ui/lib/aws-credentials.js';

const VALID_CREDENTIAL = {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    accessToken: 'access-token',
    refreshToken: 'refresh-token'
};

describe('AWS 凭据导入纯函数', () => {
    test('多文件合并时后上传字段覆盖先上传字段，expiresAt 取 refreshToken 文件', () => {
        const merged = mergeAwsCredentialFiles([
            {
                name: 'token.json',
                content: { accessToken: 'old-token', refreshToken: 'refresh', expiresAt: 'token-expiry' }
            },
            {
                name: 'registration.json',
                content: { clientId: 'client', clientSecret: 'secret', accessToken: 'new-token', expiresAt: 'registration-expiry' }
            }
        ]);

        expect(merged).toMatchObject({
            clientId: 'client',
            clientSecret: 'secret',
            accessToken: 'new-token',
            refreshToken: 'refresh'
        });
        expect(merged.expiresAt).toBe('token-expiry');
    });

    test('文件内容必须是对象，数组或标量会被拒绝', () => {
        expect(() => mergeAwsCredentialFiles([{ name: 'a.json', content: [] }]))
            .toThrow('invalid-credential-file');
        expect(() => mergeAwsCredentialFiles([{ name: 'a.json', content: 'text' }]))
            .toThrow('invalid-credential-file');
    });

    test('单条凭据校验缺失字段', () => {
        expect(validateAwsCredentials(VALID_CREDENTIAL)).toEqual({
            valid: true,
            isBatch: false,
            items: [{ index: 1, valid: true, missing: [] }]
        });

        const invalid = validateAwsCredentials({ clientId: 'c', accessToken: 'a' });
        expect(invalid.valid).toBe(false);
        expect(invalid.items[0].missing).toEqual(['clientSecret', 'refreshToken']);
    });

    test('批量凭据逐条校验，空数组不合法', () => {
        const partial = validateAwsCredentials([
            VALID_CREDENTIAL,
            { clientId: 'c2', clientSecret: '', accessToken: 'a2', refreshToken: 'r2' }
        ]);
        expect(partial.isBatch).toBe(true);
        expect(partial.valid).toBe(false);
        expect(partial.items).toHaveLength(2);
        expect(partial.items[1]).toMatchObject({ index: 2, valid: false, missing: ['clientSecret'] });

        expect(validateAwsCredentials([]).valid).toBe(false);
        expect(validateAwsCredentials(null).valid).toBe(false);
    });

    test('normalize 补齐 authMethod 且不修改原对象', () => {
        const original = { ...VALID_CREDENTIAL, authMethod: 'IdC' };
        const normalized = normalizeAwsCredentials([VALID_CREDENTIAL, original]);
        expect(normalized[0].authMethod).toBe('builder-id');
        expect(normalized[1].authMethod).toBe('IdC');
        expect(VALID_CREDENTIAL.authMethod).toBeUndefined();
        expect(original.authMethod).toBe('IdC');
    });

    test('redact 只脱敏敏感字段，保留 clientId 与 region', () => {
        const credential = {
            ...VALID_CREDENTIAL,
            clientSecret: '1234567890abcdef',
            accessToken: 'abcdefghijklmnop',
            refreshToken: 'qrstuvwxyz012345',
            region: 'us-east-1'
        };

        const redacted = redactAwsCredentials(credential);
        expect(redacted.clientId).toBe('client-id');
        expect(redacted.region).toBe('us-east-1');
        expect(redacted.clientSecret).toBe('123456...cdef');
        expect(redacted.accessToken).toBe('abcdef...mnop');
        expect(redacted.refreshToken).toBe('qrstuv...2345');
        expect(credential.clientSecret).toBe('1234567890abcdef');
    });
});
