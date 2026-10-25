import { getErrorMessage } from '../src/utils/error.ts';

describe('getErrorMessage', () => {
    test('returns Error.message', () => {
        expect(getErrorMessage(new Error('boom'))).toBe('boom');
    });

    test('reads message from plain objects thrown by libraries', () => {
        expect(getErrorMessage({ message: 'axios failed', code: 'ECONNRESET' })).toBe('axios failed');
    });

    test('keeps strings unchanged', () => {
        expect(getErrorMessage('plain failure')).toBe('plain failure');
    });

    test('stringifies primitive values', () => {
        expect(getErrorMessage(42)).toBe('42');
        expect(getErrorMessage(null)).toBe('null');
        expect(getErrorMessage(undefined)).toBe('undefined');
    });

    test('does not throw for unprintable objects', () => {
        expect(getErrorMessage(Object.create(null))).toBe('[unprintable error]');
    });

    test('falls back for objects without a string message', () => {
        expect(getErrorMessage({ message: 123 })).toBe('[object Object]');
    });
});
