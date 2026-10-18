"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallMediaHandler = void 0;
/**
 * src/Media/callMediaHandler.ts   (the "WebRTC handler" you asked for)
 *
 * Despite the usual name, there is no RTCPeerConnection here on purpose: the
 * fork's WASM VoIP engine owns the real WhatsApp media session (relay UDP,
 * key derivation, Opus/H.264, jitter buffer). This module drives it:
 *
 *   playback : 'opus:<file.ogg>' / 'yuv:<file.yuv>' (inside lib/Voip OggOpusFeeder /
 *              VideoFeeder) -> engine -> remote phone.
 *              Sources are handed to `session.accept({audioSource, videoSource})`.
 *   record   : remote audio/video -> CallRecorder -> .ogg / .h264
 *
 * (`@roamhq/wrtc` is only used inside the fork's relay transport for ICE-style
 *  connectivity checks against WhatsApp relays, not for SDP negotiation.)
 */
const node_events_1 = require("node:events");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const callRecorder_1 = require("./callRecorder");
const logger_1 = require("./logger");
class CallMediaHandler extends node_events_1.EventEmitter {
    session;
    opts;
    log;
    recorder;
    recording = null;
    constructor(session, opts = {}, log = logger_1.consoleLogger) {
        super();
        this.session = session;
        this.opts = opts;
        this.log = log;
        const rec = opts.record;
        if (rec) {
            const ro = rec === true ? { dir: (0, node_path_1.resolve)('recordings') } : rec;
            // Attach BEFORE accept so we never miss the first packets.
            this.recorder = new callRecorder_1.CallRecorder(session, { ...ro, isVideo: session.isVideo }, log);
            this.recorder.on('error', e => this.emit('error', e));
            this.recorder.start();
        }
    }
    /** Accept the call and start feeding media. Resolves when accept was sent. */
    async answer() {
        const p = this.opts.playback ?? {};
        const audioSource = this.pickSource(p.audio, 'silence');
        const acceptOpts = {
            audioSource,
            repeatAudio: p.loopAudio ?? false
        };
        if (this.session.isVideo) {
            const v = this.pickSource(p.video, undefined);
            if (v) {
                acceptOpts.videoSource = v;
                acceptOpts.isCameraEnabled = true;
                acceptOpts.videoLoop = p.loopVideo ?? false;
                if (p.width)
                    acceptOpts.videoWidth = p.width;
                if (p.height)
                    acceptOpts.videoHeight = p.height;
                if (p.fps)
                    acceptOpts.videoFps = p.fps;
            }
        }
        acceptOpts.isMicEnabled = true;
        this.log.info?.({ callId: this.session.callId, acceptOpts }, 'accepting call');
        await this.session.accept(acceptOpts);
    }
    /** Stop recording and return the files. Idempotent. */
    stop() {
        if (!this.recorder)
            return Promise.resolve(null);
        this.recording ??= this.recorder.stop();
        return this.recording;
    }
    pickSource(src, fallback) {
        if (!src)
            return fallback;
        if (src === 'silence')
            return src;
        // ffmpeg-free sources only:
        //   audio: 'opus:<file.ogg>'  (pre-encoded Ogg Opus)
        //   video: 'yuv:<file.yuv>'   (pre-decoded raw I420, size/fps from playback.width/height/fps)
        const m = /^(opus|yuv):(.+)$/.exec(src);
        if (!m) {
            this.log.warn?.({ src }, 'unsupported media source (ffmpeg was removed): use opus:<file.ogg> or yuv:<file.yuv>');
            return fallback;
        }
        if (/^https?:\/\//i.test(m[2]))
            return `${m[1]}:${m[2]}`; // remote URL: streamed, not downloaded
        const abs = (0, node_path_1.resolve)(m[2]);
        if (!(0, node_fs_1.existsSync)(abs)) {
            this.log.warn?.({ src: abs }, 'media file not found; falling back');
            return fallback;
        }
        return `${m[1]}:${abs}`;
    }
}
exports.CallMediaHandler = CallMediaHandler;
