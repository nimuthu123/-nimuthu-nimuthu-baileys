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
import { EventEmitter } from 'node:events';
import { type Logger } from './logger';
export interface RecordOptions {
    /** Output directory (created if missing). */
    dir: string;
    /** File name stem. Default: call id. */
    baseName?: string;
    audio?: boolean;
    video?: boolean;
    /** Engine playback rate. The fork documents 16 kHz mono. */
    sampleRate?: number;
    channels?: number;
    /**
     * Force the incoming video format if the engine's `format` field is not recognised:
     * 'yuv420p' | 'nv12' | 'nv21' | 'rgba' | 'bgra' | 'h264'.
     */
    videoFormatOverride?: string;
}
export interface RecordingResult {
    /** <base>.ogg (Ogg Opus) */
    audioPath?: string;
    /** .h264 (Annex-B) or raw dumps; one file per format/resolution change. */
    videoSegments: string[];
    /** kept for API compatibility - muxing needs ffmpeg and was removed */
    muxedPath?: undefined;
    durationMs: number;
    audioBytes: number;
    videoFrames: number;
}
/** Shape of frames emitted by the engine's onVideoFrameWasmToJs. */
export interface RemoteVideoFrame {
    frameBuffer: ArrayBuffer | ArrayBufferView;
    width: number;
    height: number;
    format?: string | number;
    timestamp?: number;
    isKeyFrame?: boolean;
    orientation?: number;
}
type PixFmt = 'yuv420p' | 'nv12' | 'nv21' | 'rgba' | 'bgra' | 'h264';
export declare function normalizeVideoFormat(f: string | number | undefined, override?: string): PixFmt | null;
export declare class CallRecorder extends EventEmitter {
    private readonly session;
    private readonly o;
    private readonly log;
    private started;
    private stopped;
    private result?;
    private aw;
    private aPath?;
    private aT0;
    private aFrames;
    private vOut;
    private vSegments;
    private vFmt;
    private vW;
    private vH;
    private vFrames;
    private vWaitKey;
    private startedAt;
    private warnedRaw;
    private readonly onAudio;
    private readonly onVideo;
    constructor(session: EventEmitter, opts: RecordOptions & {
        isVideo?: boolean;
    }, log?: Logger);
    start(): this;
    /** Detach, flush encoders. Safe to call more than once. */
    stop(): Promise<RecordingResult>;
    private finalize;
    private writeAudio;
    private writeVideo;
    private openVideoSegment;
}
export declare function expectedFrameBytes(fmt: Exclude<PixFmt, 'h264'>, w: number, h: number): number;
export {};
