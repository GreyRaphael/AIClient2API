jest.mock('open', () => ({ default: jest.fn() }));

jest.mock('../src/ui-modules/auth.ts', () => ({
    checkAuth: jest.fn(async () => true),
    handleLoginRequest: jest.fn(async () => true)
}));

jest.mock('../src/ui-modules/provider-api.ts', () => ({
    handleGetProviderModelMetadata: jest.fn(async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return true;
    })
}));

import { describe, test, expect } from '@jest/globals';
import { handleUIApiRequests } from '../src/services/ui-manager.ts';
import * as providerApi from '../src/ui-modules/provider-api.ts';
import * as auth from '../src/ui-modules/auth.ts';

function createResponse() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(status, headers) {
            this.statusCode = status;
            this.headers = headers;
        },
        end(body = '') {
            this.body += body;
        }
    };
}

describe('UI manager route dispatch', () => {
    test('GET /api/provider-models/metadata 路由到 metadata handler', async () => {
        const res = createResponse();

        const handled = await handleUIApiRequests(
            'GET',
            '/api/provider-models/metadata',
            { headers: {} },
            res,
            {},
            null
        );

        expect(handled).toBe(true);
        expect(auth.checkAuth).toHaveBeenCalled();
        expect(providerApi.handleGetProviderModelMetadata).toHaveBeenCalledTimes(1);
        expect(providerApi.handleGetProviderModelMetadata.mock.calls[0].slice(0, 2)).toEqual([
            { headers: {} },
            res
        ]);
    });
});
