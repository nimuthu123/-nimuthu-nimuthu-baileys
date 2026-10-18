"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallRecorder = void 0;
exports.normalizeVideoFormat = normalizeVideoFormat;
exports.expectedFrameBytes = expectedFrameBytes;
/**
 * src/Media/callRecorder.ts
 *
 * Records the REMOTE side of a call to disk with NO ffmpeg.
 *
 *  audio : session 'audio' events (Float32 PCM, 16 kHz mono) -> libopus (opusscript, in-process)
 *          -> our own Ogg muxer -> <base>.ogg   (Ogg Opus)
 *  video : session 'videoFrame' events (needs scripts/apply-video-rx-patch.cjs)
 *          H.264 Annex-B frames are appended as-is  -> <base>.video.h264
 *          Raw frames (I420/NV12/RGBA...) cannot become .h264 without a video encoder, so they are
 *          dumped as <base>.video.<WxH>.<fmt> (raw, large) and a warning is logged.
 *
 * Audio gaps: the engine only emits chunks that contain non-zero samples, so silence produces no
 * events. We pad silence from the wall clock so pauses are preserved.
 *
 * Legal: recording a call generally requires the other party's consent.
 */
const node_events_1 = require("node:events");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const logger_1 = require("./logger");
const oggOpusWriter_1 = require("./oggOpusWriter");
function normalizeVideoFormat(f, override) {
    const s = String(override ?? f ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (['i420', 'yuv420', 'yuv420p', 'iyuv', 'yv12'].includes(s))
        return 'yuv420p';
    if (s === 'nv12')
        return 'nv12';
    if (s === 'nv21')
        return 'nv21';
    if (['rgba', 'rgba8888'].includes(s))
        return 'rgba';
    if (['bgra', 'bgra8888'].includes(s))
        return 'bgra';
    if (['h264', 'avc', 'avc1', 'annexb'].includes(s))
        return 'h264';
    return null;
}
class CallRecorder extends node_events_1.EventEmitter {
    session;
    o;
    log;
    started = false;
    stopped = false;
    result;
    // audio state
    aw = null;
    aPath;
    aT0 = 0; // wall clock (ms) of first audio chunk
    aFrames = 0; // frames (per channel) written, incl. padding
    // video state
    vOut = null;
    vSegments = [];
    vFmt = null;
    vW = 0;
    vH = 0;
    vFrames = 0;
    vWaitKey = true;
    startedAt = 0;
    warnedRaw = false;
    onAudio = (pcm) => this.writeAudio(pcm);
    onVideo = (f) => this.writeVideo(f);
    constructor(session, opts, log = logger_1.consoleLogger) {
        super();
        this.session = session;
        this.log = log;
        this.o = {
            dir: opts.dir,
            baseName: opts.baseName ?? String(session.callId ?? Date.now()),
            audio: opts.audio ?? true,
            video: opts.video ?? Boolean(opts.isVideo),
            sampleRate: opts.sampleRate ?? 16000,
            channels: opts.channels ?? 1,
            videoFormatOverride: opts.videoFormatOverride
        };
    }
    start() {
        if (this.started)
            return this;
        this.started = true;
        this.startedAt = Date.now();
        (0, node_fs_1.mkdirSync)(this.o.dir, { recursive: true });
        if (this.o.audio)
            this.session.on('audio', this.onAudio);
        if (this.o.video)
            this.session.on('videoFrame', this.onVideo);
        return this;
    }
    /** Detach, flush encoders. Safe to call more than once. */
    stop() {
        if (this.result)
            return this.result;
        this.stopped = true;
        this.session.off('audio', this.onAudio);
        this.session.off('videoFrame', this.onVideo);
        this.result = this.finalize();
        return this.result;
    }
    async finalize() {
        const audioBytes = this.aw?.bytes ?? 0;
        const hadPackets = (this.aw?.packets ?? 0) > 0;
        await Promise.all([
            this.aw?.close(),
            this.vOut ? new Promise(r => this.vOut.end(() => r())) : undefined
        ]);
        this.aw = null;
        this.vOut = null;
        if (this.aPath && !hadPackets && (0, node_fs_1.existsSync)(this.aPath))
            (0, node_fs_1.unlinkSync)(this.aPath);
        const res = {
            audioPath: this.aPath && hadPackets ? this.aPath : undefined,
            videoSegments: this.vSegments.filter(node_fs_1.existsSync),
            durationMs: Date.now() - this.startedAt,
            audioBytes,
            videoFrames: this.vFrames
        };
        this.emit('finished', res);
        return res;
    }
    /* ───────────────────────────────── audio ───────────────────────────────── */
    writeAudio(pcm) {
        if (this.stopped || !pcm?.length)
            return;
        const now = Date.now();
        const ch = this.o.channels;
        const rate = this.o.sampleRate;
        if (!this.aw) {
            this.aPath = (0, node_path_1.join)(this.o.dir, `${this.o.baseName}.ogg`);
            this.aw = new oggOpusWriter_1.OggOpusWriter(this.aPath, rate, ch);
            this.aT0 = now;
        }
        const chunkFrames = Math.floor(pcm.length / ch);
        const expectedEnd = Math.round(((now - this.aT0) / 1000) * rate);
        const gap = expectedEnd - this.aFrames - chunkFrames;
        if (gap > rate * 0.04) { // > 40 ms: engine skipped silence -> pad it
            const pad = Math.min(gap, rate * 600);
            this.aw.writeSilence((pad / rate) * 1000);
            this.aFrames += pad;
        }
        // `pcm` is a view over WASM heap memory - writePcm copies synchronously.
        this.aw.writePcm(pcm.subarray(0, chunkFrames * ch));
        this.aFrames += chunkFrames;
    }
    /* ───────────────────────────────── video ───────────────────────────────── */
    writeVideo(f) {
        if (this.stopped || !f?.frameBuffer)
            return;
        const fmt = normalizeVideoFormat(f.format, this.o.videoFormatOverride);
        if (!fmt) {
            this.log.warn?.({ format: f.format }, 'unknown remote video format; set videoFormatOverride');
            return;
        }
        const data = Buffer.from(ArrayBuffer.isView(f.frameBuffer)
            ? new Uint8Array(f.frameBuffer.buffer, f.frameBuffer.byteOffset, f.frameBuffer.byteLength)
            : new Uint8Array(f.frameBuffer));
        const changed = !this.vOut || fmt !== this.vFmt || (fmt !== 'h264' && (f.width !== this.vW || f.height !== this.vH));
        if (changed) {
            if (fmt === 'h264' && !f.isKeyFrame && !this.vOut)
                return; // must start on an IDR
            this.vOut?.end();
            this.openVideoSegment(fmt, f.width, f.height);
        }
        if (this.vWaitKey && fmt === 'h264' && !f.isKeyFrame)
            return;
        this.vWaitKey = false;
        const out = this.vOut;
        if (out.destroyed || out.writableLength > 64 * 1024 * 1024)
            return; // disk stalled: drop
        if (fmt !== 'h264') {
            const need = expectedFrameBytes(fmt, f.width, f.height);
            if (data.length < need)
                return; // truncated frame
            out.write(data.subarray(0, need));
        }
        else {
            out.write(data); // Annex-B NAL units are written as received
        }
        this.vFrames++;
    }
    openVideoSegment(fmt, w, h) {
        const idx = this.vSegments.length;
        const suffix = idx ? `-${idx}` : '';
        const name = fmt === 'h264'
            ? `${this.o.baseName}.video${suffix}.h264`
            : `${this.o.baseName}.video${suffix}.${w}x${h}.${fmt}`;
        const path = (0, node_path_1.join)(this.o.dir, name);
        this.vSegments.push(path);
        this.vFmt = fmt;
        this.vW = w;
        this.vH = h;
        this.vWaitKey = fmt === 'h264';
        if (fmt !== 'h264' && !this.warnedRaw) {
            this.warnedRaw = true;
            this.log.warn?.({ fmt }, 'engine delivers RAW video; .h264 needs an encoder, so raw frames are dumped instead');
        }
        this.vOut = (0, node_fs_1.createWriteStream)(path);
        this.vOut.on('error', () => undefined);
    }
}
exports.CallRecorder = CallRecorder;
function expectedFrameBytes(fmt, w, h) {
    switch (fmt) {
        case 'yuv420p':
        case 'nv12':
        case 'nv21': return Math.floor((w * h * 3) / 2);
        case 'rgba':
        case 'bgra': return w * h * 4;
    }
}
