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
import { EventEmitter } from 'node:events';
import { type RecordOptions, type RecordingResult } from './callRecorder';
import { type Logger } from './logger';
export interface PlaybackOptions {
    /** 'opus:<file.ogg>' (pre-encoded Ogg Opus) or 'silence'. */
    audio?: string;
    /** 'yuv:<file.yuv>' raw I420 frames (set width/height/fps to match the file). Video calls only. */
    video?: string;
    loopAudio?: boolean;
    loopVideo?: boolean;
    /** Video calls: output geometry sent to the caller. */
    width?: number;
    height?: number;
    fps?: number;
}
export interface CallMediaOptions {
    playback?: PlaybackOptions;
    /** `true` => defaults into ./recordings. */
    record?: boolean | RecordOptions;
}
export interface CallSessionForMedia extends EventEmitter {
    readonly callId: string;
    readonly isVideo: boolean;
    accept(opts?: Record<string, unknown>): Promise<void>;
}
export declare class CallMediaHandler extends EventEmitter {
    private readonly session;
    private readonly opts;
    private readonly log;
    private recorder?;
    private recording;
    constructor(session: CallSessionForMedia, opts?: CallMediaOptions, log?: Logger);
    /** Accept the call and start feeding media. Resolves when accept was sent. */
    answer(): Promise<void>;
    /** Stop recording and return the files. Idempotent. */
    stop(): Promise<RecordingResult | null>;
    private pickSource;
}
