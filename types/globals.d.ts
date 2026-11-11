export {};

declare global {
    namespace Temporal {
        class PlainDate {
            toString(): string;
            add(duration: { days?: number; months?: number; weeks?: number; years?: number }): PlainDate;
            subtract(duration: { days?: number; months?: number; weeks?: number; years?: number }): PlainDate;
        }
        class PlainDateTime {
            toString(options?: { fractionalSecondDigits?: number }): string;
        }
        class ZonedDateTime {
            epochMilliseconds: number;
            toPlainDate(): PlainDate;
            add(duration: { days?: number; months?: number; weeks?: number; years?: number; hours?: number; seconds?: number }): ZonedDateTime;
            subtract(duration: { days?: number; months?: number; weeks?: number; years?: number; hours?: number; seconds?: number }): ZonedDateTime;
            toString(options?: { fractionalSecondDigits?: number }): string;
        }
        class Instant {
            add(duration: { seconds?: number; milliseconds?: number; hours?: number; days?: number }): Instant;
            subtract(duration: { seconds?: number; milliseconds?: number; hours?: number; days?: number }): Instant;
            toString(options?: { fractionalSecondDigits?: number }): string;
            epochMilliseconds: number;
            toZonedDateTimeISO(timeZone: string): ZonedDateTime;
            until(other: Instant): { total(options: { unit: string }): number };
            static from(item: string | Instant): Instant;
            static compare(one: Instant | string, two: Instant | string): number;
            static fromEpochMilliseconds(epochMilliseconds: number): Instant;
        }
        namespace Now {
            function plainDateISO(timeZone?: string): PlainDate;
            function plainDateTimeISO(timeZone?: string): PlainDateTime;
            function instant(): Instant;
            function zonedDateTimeISO(timeZone?: string): ZonedDateTime;
        }
    }
    const Temporal: typeof Temporal;

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
