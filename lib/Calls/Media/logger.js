"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.consoleLogger = void 0;
exports.consoleLogger = {
    debug: () => undefined,
    info: (o, m) => console.log('[calls]', m ?? '', o),
    warn: (o, m) => console.warn('[calls]', m ?? '', o),
    error: (o, m) => console.error('[calls]', m ?? '', o)
};
