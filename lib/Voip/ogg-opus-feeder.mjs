/**
 * OggOpusFeeder - play a PRE-ENCODED Ogg Opus file into a call WITHOUT ffmpeg.
 *
 *   fs.createReadStream -> tiny Ogg demuxer -> Opus packets -> WASM libopus decode
 *   -> exact 20 ms PCM chunks -> drift-corrected 20 ms timer -> engine uplink.
 *
 * NOTE: the WhatsApp VoIP engine accepts only raw Float32 PCM at its capture
 * port (`onAudioDataFromJs`) and runs its OWN Opus encoder. There is no entry
 * point for injecting Opus packets, so the packets are decoded here (in-process
 * WASM, ~a few ms per second of audio) and the engine re-encodes them.
 * No child process, no transcoding pipeline at call time.
 *
 * Use:  audioSource: "opus:/path/to/greeting.ogg"
 * Make the file once, offline:
 *   opusenc --bitrate 24 in.wav out.ogg      (or: ffmpeg -i in.mp3 -c:a libopus -b:a 24k -ar 16000 -ac 1 out.ogg)
 *
 * Same constructor / start / stop / counters as AudioFeeder (drop-in).
 */
import { createReadStream, existsSync } from "node:fs";
import { resolve } from "node:path";
import { openSource, isUrl } from "./url-stream.mjs";

const MAX_QUEUED_CHUNKS = 250; // ~5 s of audio buffered at most (backpressure)
const RESUME_AT_CHUNKS = 100;
const PREFIX = "opus:";

export const isOggOpusSource = (s) => typeof s === "string" && s.startsWith(PREFIX);

/** Incremental Ogg page parser -> complete packets (handles lacing + page continuation). */
export class OggPacketParser {
    #buf = Buffer.alloc(0);
    #partial = []; // pieces of a packet continued across segments/pages
    constructor(onPacket) { this.onPacket = onPacket; }

    push(chunk) {
        this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
        for (;;) {
            const b = this.#buf;
            if (b.length < 27) return;
            if (b.readUInt32BE(0) !== 0x4f676753) { // "OggS" - resync on garbage
                const i = b.indexOf("OggS", 1, "latin1");
                this.#buf = i < 0 ? b.subarray(b.length - 3) : b.subarray(i);
                if (i < 0) return;
                continue;
            }
            const nseg = b[26];
            if (b.length < 27 + nseg) return;
            let bodyLen = 0;
            for (let i = 0; i < nseg; i++) bodyLen += b[27 + i];
            const total = 27 + nseg + bodyLen;
            if (b.length < total) return;
            // header_type bit0 = continued packet; if not continued, drop stale partial
            if (!(b[5] & 1)) this.#partial = [];
            let off = 27 + nseg;
            for (let i = 0; i < nseg; i++) {
                const len = b[27 + i];
                this.#partial.push(b.subarray(off, off + len));
                off += len;
                if (len < 255) { // packet complete
                    const pkt = this.#partial.length === 1 ? this.#partial[0] : Buffer.concat(this.#partial);
                    this.#partial = [];
                    this.onPacket(Buffer.from(pkt)); // copy: detach from the read buffer
                }
            }
            this.#buf = b.subarray(total);
        }
    }
    reset() { this.#buf = Buffer.alloc(0); this.#partial = []; }
}

export class OggOpusFeeder {
    sampleRate; channels; framesPerChunk; onChunk; onEnd; repeat; durationMs; source;

    #finished = false;
    #stream = null;
    #parser = null;
    #decoder = null;
    #decoderPromise = null;
    #queue = [];
    #pcm = []; // decoded mono-mixed samples waiting to be sliced to chunks (Float32Array parts)
    #pcmLen = 0;
    #packetNo = 0;
    #preSkip = 0;
    #srcChannels = 1;
    #eof = false;
    #timer = null;
    #nextAt = 0;
    #decodeChain = Promise.resolve();
    #started = false;
    #warmupUntil = 0;

    droppedChunks = 0; underflowChunks = 0; bytesProduced = 0; chunksEmitted = 0; emittedDurationMs = 0;

    constructor(sampleRate, channels, framesPerChunk, onChunk, source, onEnd = null, options = {}) {
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.framesPerChunk = framesPerChunk;
        this.onChunk = onChunk;
        this.onEnd = onEnd;
        this.repeat = Boolean(options.repeat || options.repeatAudio);
        this.durationMs = Number(options.durationMs ?? options.durationMS ?? 0);
        let p = String(source).slice(PREFIX.length);
        if (!isUrl(p) && !existsSync(p)) p = resolve(process.cwd(), p);
        this.source = p;
    }

    start = () => {
        if (this.#started) return;
        this.#started = true;
        this.#finished = false;
        this.chunksEmitted = 0;
        this.emittedDurationMs = 0;
        if (!isUrl(this.source) && !existsSync(this.source)) return this.#finish();
        this.#openStream();
        this.#nextAt = 0;
        this.#warmupUntil = Date.now() + 500; // let decoder spin up, avoid leading gaps
        this.#schedule();
    };

    stop = () => {
        if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
        this.#closeStream();
        this.#queue = []; this.#pcm = []; this.#pcmLen = 0;
        const dec = this.#decoder; this.#decoder = null; this.#decoderPromise = null;
        if (dec) this.#decodeChain = this.#decodeChain.then(() => { try { dec.free(); } catch { } });
        this.#started = false;
    };

    // ---- input side -------------------------------------------------------
    #openStream = () => {
        this.#packetNo = 0; this.#eof = false;
        this.#parser = new OggPacketParser((pkt) => this.#onPacket(pkt));
        const s = openSource(this.source, { highWaterMark: 16 * 1024 });
        this.#stream = s;
        s.on("data", (c) => {
            this.#parser?.push(c);
            if (this.#queue.length >= MAX_QUEUED_CHUNKS) s.pause();
        });
        s.on("end", () => { this.#decodeChain = this.#decodeChain.then(() => { this.#eof = true; this.#maybeLoop(); }); });
        s.on("error", () => { this.#eof = true; });
    };
    #closeStream = () => {
        if (this.#stream) { this.#stream.destroy(); this.#stream = null; }
        this.#parser?.reset(); this.#parser = null;
    };

    #onPacket = (pkt) => {
        const n = this.#packetNo++;
        if (n === 0) { // OpusHead
            if (pkt.length < 19 || pkt.toString("latin1", 0, 8) !== "OpusHead") { this.#eof = true; this.#closeStream(); return; }
            this.#srcChannels = Math.min(2, Math.max(1, pkt[9]));
            this.#preSkip = Math.round(pkt.readUInt16LE(10) * this.sampleRate / 48000);
            return;
        }
        if (n === 1) return; // OpusTags
        // serialise decodes so order is preserved; decoder created lazily once
        this.#decodeChain = this.#decodeChain.then(async () => {
            if (!this.#started) return;
            if (!this.#decoder) {
                this.#decoderPromise ??= import("opus-decoder").then(({ OpusDecoder }) => {
                    const d = new OpusDecoder({ sampleRate: this.sampleRate, channels: this.#srcChannels });
                    return d.ready.then(() => d);
                });
                this.#decoder = await this.#decoderPromise;
            }
            const r = this.#decoder.decodeFrame(pkt);
            if (!r || !r.samplesDecoded) return;
            this.#pushPcm(r.channelData, r.samplesDecoded);
        }).catch(() => { });
    };

    #pushPcm = (chans, n) => {
        // mix source channels to engine channel count (engine capture is normally mono)
        const out = new Float32Array(n * this.channels);
        for (let i = 0; i < n; i++) {
            if (this.channels === 1) {
                out[i] = chans.length > 1 ? (chans[0][i] + chans[1][i]) * 0.5 : chans[0][i];
            } else {
                for (let c = 0; c < this.channels; c++) out[i * this.channels + c] = chans[Math.min(c, chans.length - 1)][i];
            }
        }
        let part = out;
        if (this.#preSkip > 0) { // drop encoder pre-skip once at start
            const skip = Math.min(this.#preSkip, n);
            this.#preSkip -= skip;
            part = out.subarray(skip * this.channels);
        }
        if (!part.length) return;
        this.#pcm.push(part); this.#pcmLen += part.length;
        const chunkSamples = this.framesPerChunk * this.channels;
        while (this.#pcmLen >= chunkSamples) {
            const chunk = new Float32Array(chunkSamples);
            let filled = 0;
            while (filled < chunkSamples) {
                const head = this.#pcm[0];
                const take = Math.min(head.length, chunkSamples - filled);
                chunk.set(head.subarray(0, take), filled);
                filled += take;
                if (take === head.length) this.#pcm.shift(); else this.#pcm[0] = head.subarray(take);
            }
            this.#pcmLen -= chunkSamples;
            this.bytesProduced += chunk.byteLength;
            this.#queue.push(chunk);
        }
    };

    #flushTail = () => {
        const chunkSamples = this.framesPerChunk * this.channels;
        const chunk = new Float32Array(chunkSamples);
        let filled = 0;
        for (const part of this.#pcm) { chunk.set(part, filled); filled += part.length; }
        this.#pcm = []; this.#pcmLen = 0;
        this.#queue.push(chunk);
    };

    #maybeLoop = () => {
        if (!this.#started || this.#finished) return;
        if (this.repeat && this.#eof) { this.#eof = false; this.#closeStream(); this.#openStream(); }
    };

    // ---- output side: exact 20 ms pacing ------------------------------------
    #schedule = () => {
        const intervalMs = (this.framesPerChunk / this.sampleRate) * 1000;
        const now = Date.now();
        if (this.#nextAt === 0) this.#nextAt = now;
        this.#timer = setTimeout(() => {
            this.#timer = null;
            if (this.#finished || !this.#started) return;
            if (this.#queue.length < 5 && !this.#eof && Date.now() < this.#warmupUntil) {
                this.#nextAt = Date.now() + 10;
                return this.#schedule();
            }
            if (!this.#queue.length && this.#eof && this.#pcmLen > 0) this.#flushTail(); // pad last <20 ms remainder
            const chunk = this.#queue.shift();
            if (!chunk) {
                const drained = this.#eof && !this.repeat && this.#pcmLen === 0;
                if (drained) return this.#finish();
                if (this.#packetNo > 2 || this.#eof) { // mid-stream underflow -> silence keeps cadence
                    this.underflowChunks++;
                    this.#emit(new Float32Array(this.framesPerChunk * this.channels), intervalMs);
                }
            } else {
                this.#emit(chunk, intervalMs);
            }
            if (this.#finished) return;
            if (this.#stream?.isPaused() && this.#queue.length <= RESUME_AT_CHUNKS) this.#stream.resume();
            this.#nextAt += intervalMs;
            if (Date.now() - this.#nextAt > 200) this.#nextAt = Date.now(); // long stall: resync, don't burst
            this.#schedule();
        }, Math.max(0, this.#nextAt - now));
        this.#timer.unref?.();
    };

    #emit = (chunk, intervalMs) => {
        this.chunksEmitted++;
        this.emittedDurationMs = this.chunksEmitted * intervalMs;
        this.onChunk(chunk);
        if (this.durationMs > 0 && this.emittedDurationMs >= this.durationMs) this.#finish();
    };

    #finish = () => {
        if (this.#finished) return;
        this.#finished = true;
        this.stop();
        this.onEnd?.();
    };
}
