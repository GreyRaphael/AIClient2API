export {};

declare global {
    // Node 26 的 Temporal 尚无官方 TypeScript 类型（@types/node 未提供），这里只声明
    // 本项目实际用到的子集。声明必须与运行时语义一致，否则会把真实错误藏到运行期：
    // - Duration 的日历单位（years/months/weeks/days）只能用于 ZonedDateTime/PlainDate，
    //   对 Instant 使用会抛 RangeError（"Largest unit cannot be a date unit"）。
    // - `epochMilliseconds` 是只读访问器，不是可写字段。
    namespace Temporal {
        /** Instant 可接受的固定时长单位（不含日历单位） */
        interface TimeDuration {
            hours?: number;
            minutes?: number;
            seconds?: number;
            milliseconds?: number;
            microseconds?: number;
            nanoseconds?: number;
        }

        /** 日历单位时长，仅 PlainDate / ZonedDateTime 接受 */
        interface DateDuration extends TimeDuration {
            years?: number;
            months?: number;
            weeks?: number;
            days?: number;
        }

        class PlainDate {
            toString(): string;
            add(duration: DateDuration): PlainDate;
            subtract(duration: DateDuration): PlainDate;
        }
        class PlainDateTime {
            toString(options?: { fractionalSecondDigits?: number }): string;
        }
        class ZonedDateTime {
            readonly epochMilliseconds: number;
            toPlainDate(): PlainDate;
            add(duration: DateDuration): ZonedDateTime;
            subtract(duration: DateDuration): ZonedDateTime;
            toString(options?: { fractionalSecondDigits?: number }): string;
        }
        class Instant {
            add(duration: TimeDuration): Instant;
            subtract(duration: TimeDuration): Instant;
            toString(options?: { fractionalSecondDigits?: number }): string;
            readonly epochMilliseconds: number;
            toZonedDateTimeISO(timeZone: string): ZonedDateTime;
            until(other: Instant, options?: { largestUnit?: string }): { total(options: { unit: string }): number };
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
