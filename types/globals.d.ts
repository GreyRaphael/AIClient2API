export {};

declare global {
    interface Error {
        code?: string | number;
        status?: number;
        statusCode?: number;
        response?: any;
        retryAfterMs?: number;
        shouldSwitchCredential?: boolean;
        credentialMarkedUnhealthy?: boolean;
        skipErrorCount?: boolean;
        isEmptyUpstreamResponse?: boolean;
    }
}

declare module 'node:http' {
    interface IncomingMessage {
        file?: any;
        body?: any;
    }
}
