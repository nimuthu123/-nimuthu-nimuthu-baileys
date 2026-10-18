/** Minimal pino-compatible logger surface; pass a pino instance or use the default. */
export interface Logger {
    debug?(obj: unknown, msg?: string): void;
    info?(obj: unknown, msg?: string): void;
    warn?(obj: unknown, msg?: string): void;
    error?(obj: unknown, msg?: string): void;
}
export declare const consoleLogger: Logger;
