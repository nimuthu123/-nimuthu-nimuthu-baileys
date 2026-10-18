/** Open a local path OR an http(s) URL as a Readable (URLs are streamed, never saved to disk). */
import { createReadStream } from "node:fs";
import { PassThrough, Readable } from "node:stream";
export const isUrl = (s) => /^https?:\/\//i.test(String(s));
export function openSource(source, opts = {}) {
    if (!isUrl(source)) return createReadStream(source, opts);
    const out = new PassThrough({ highWaterMark: opts.highWaterMark || 64 * 1024 });
    const ac = new AbortController();
    out.on("close", () => ac.abort());
    fetch(source, { signal: ac.signal, redirect: "follow" })
        .then((res) => {
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${source}`);
            const src = Readable.fromWeb(res.body);
            src.on("error", (e) => out.destroy(e));
            src.pipe(out);
        })
        .catch((e) => { if (!ac.signal.aborted) out.destroy(e); });
    return out;
}
