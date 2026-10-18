/**
 * RawVideoFeeder - play a PRE-DECODED raw I420 (yuv420p) file into a video call WITHOUT ffmpeg.
 * Source: "yuv:/path/demo.yuv"; frame size/fps come from the call's video options and MUST match the file.
 * fs.createReadStream -> fixed-size frames -> drift-corrected timer at `fps`. Same API as VideoFeeder.
 * Make the file once, offline:  ffmpeg -i demo.mp4 -vf scale=640:480 -r 15 -pix_fmt yuv420p demo.yuv
 */
import { createReadStream, existsSync } from "node:fs";
import { resolve } from "node:path";
import { openSource, isUrl } from "./url-stream.mjs";

const PREFIX = "yuv:";
const MAX_QUEUED_FRAMES = 8;
export const isRawVideoSource = (s) => typeof s === "string" && s.startsWith(PREFIX);

export class RawVideoFeeder {
    width; height; fps; frameDurationMs; frameSizeBytes; onFrame; onEnd; onError; loop; durationMs; source;
    #running = false; #stream = null; #pending = []; #pendingBytes = 0; #queue = [];
    #timer = null; #nextAt = 0; #eof = false;
    framesProduced = 0; framesEmitted = 0; bytesProduced = 0;

    constructor(source, onFrame, onEnd = null, onError = null, options = {}) {
        let p = String(source).slice(PREFIX.length);
        if (!isUrl(p) && !existsSync(p)) p = resolve(process.cwd(), p);
        if (!isUrl(p) && !existsSync(p)) throw new Error(`Video source file not found: ${source}`);
        this.source = p;
        this.onFrame = onFrame; this.onEnd = onEnd; this.onError = onError;
        this.width = Number(options.width || options.videoWidth || 640);
        this.height = Number(options.height || options.videoHeight || 480);
        if (this.width % 2) this.width++;
        if (this.height % 2) this.height++;
        this.fps = Math.max(1, Math.min(60, Number(options.fps || options.videoFps || 15)));
        this.frameDurationMs = 1000 / this.fps;
        this.frameSizeBytes = Math.floor(this.width * this.height * 1.5);
        this.loop = Boolean(options.loop || options.videoLoop || options.repeatVideo);
        this.durationMs = Number(options.durationMs ?? options.durationMS ?? 0);
    }
    get isRunning() { return this.#running; }

    start = () => {
        if (this.#running) return;
        this.#running = true;
        this.framesProduced = this.framesEmitted = this.bytesProduced = 0;
        this.#open();
        this.#nextAt = 0;
        this.#tick();
    };

    stop = () => {
        this.#running = false;
        if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
        this.#close();
        this.#queue = []; this.#pending = []; this.#pendingBytes = 0;
    };

    #open = () => {
        this.#eof = false;
        const s = openSource(this.source, { highWaterMark: this.frameSizeBytes * 2 });
        this.#stream = s;
        s.on("data", (c) => {
            this.#pending.push(c); this.#pendingBytes += c.length; this.bytesProduced += c.length;
            while (this.#pendingBytes >= this.frameSizeBytes) {
                const all = this.#pending.length === 1 ? this.#pending[0] : Buffer.concat(this.#pending);
                this.#queue.push(Buffer.from(all.subarray(0, this.frameSizeBytes))); // copy
                const rest = all.subarray(this.frameSizeBytes);
                this.#pending = rest.length ? [rest] : []; this.#pendingBytes = rest.length;
                this.framesProduced++;
            }
            if (this.#queue.length >= MAX_QUEUED_FRAMES) s.pause();
        });
        s.on("end", () => { this.#eof = true; });
        s.on("error", (e) => { this.#running = false; this.onError?.(e); });
    };
    #close = () => { if (this.#stream) { this.#stream.destroy(); this.#stream = null; } };

    #tick = () => {
        const now = Date.now();
        if (this.#nextAt === 0) this.#nextAt = now;
        this.#timer = setTimeout(() => {
            this.#timer = null;
            if (!this.#running) return;
            const f = this.#queue.shift();
            if (f) {
                this.framesEmitted++;
                try { this.onFrame?.(f, this.width, this.height, this.fps); } catch (e) { this.onError?.(e); }
                if (this.#stream?.isPaused() && this.#queue.length < MAX_QUEUED_FRAMES / 2) this.#stream.resume();
                if (this.durationMs > 0 && this.framesEmitted * this.frameDurationMs >= this.durationMs) return this.#end();
            } else if (this.#eof) {
                if (this.loop) { this.#close(); this.#pending = []; this.#pendingBytes = 0; this.#open(); }
                else return this.#end();
            }
            this.#nextAt += this.frameDurationMs;
            if (Date.now() - this.#nextAt > 500) this.#nextAt = Date.now();
            this.#tick();
        }, Math.max(0, this.#nextAt - now));
        this.#timer.unref?.();
    };
    #end = () => { if (!this.#running) return; this.stop(); this.onEnd?.(); };
}
