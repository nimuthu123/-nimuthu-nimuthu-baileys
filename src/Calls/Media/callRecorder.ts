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
import { EventEmitter } from 'node:events'
import { mkdirSync, existsSync, unlinkSync, createWriteStream, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { type Logger, consoleLogger } from './logger'
import { OggOpusWriter } from './oggOpusWriter'

export interface RecordOptions {
	/** Output directory (created if missing). */
	dir: string
	/** File name stem. Default: call id. */
	baseName?: string
	audio?: boolean // default true
	video?: boolean // default: true when the call is a video call
	/** Engine playback rate. The fork documents 16 kHz mono. */
	sampleRate?: number
	channels?: number
	/**
	 * Force the incoming video format if the engine's `format` field is not recognised:
	 * 'yuv420p' | 'nv12' | 'nv21' | 'rgba' | 'bgra' | 'h264'.
	 */
	videoFormatOverride?: string
}

export interface RecordingResult {
	/** <base>.ogg (Ogg Opus) */
	audioPath?: string
	/** .h264 (Annex-B) or raw dumps; one file per format/resolution change. */
	videoSegments: string[]
	/** kept for API compatibility - muxing needs ffmpeg and was removed */
	muxedPath?: undefined
	durationMs: number
	audioBytes: number
	videoFrames: number
}

/** Shape of frames emitted by the engine's onVideoFrameWasmToJs. */
export interface RemoteVideoFrame {
	frameBuffer: ArrayBuffer | ArrayBufferView
	width: number
	height: number
	format?: string | number
	timestamp?: number
	isKeyFrame?: boolean
	orientation?: number
}

type PixFmt = 'yuv420p' | 'nv12' | 'nv21' | 'rgba' | 'bgra' | 'h264'

export function normalizeVideoFormat(f: string | number | undefined, override?: string): PixFmt | null {
	const s = String(override ?? f ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
	if (['i420', 'yuv420', 'yuv420p', 'iyuv', 'yv12'].includes(s)) return 'yuv420p'
	if (s === 'nv12') return 'nv12'
	if (s === 'nv21') return 'nv21'
	if (['rgba', 'rgba8888'].includes(s)) return 'rgba'
	if (['bgra', 'bgra8888'].includes(s)) return 'bgra'
	if (['h264', 'avc', 'avc1', 'annexb'].includes(s)) return 'h264'
	return null
}

export class CallRecorder extends EventEmitter {
	private readonly o: Required<Omit<RecordOptions, 'videoFormatOverride'>> & { videoFormatOverride?: string }
	private readonly log: Logger
	private started = false
	private stopped = false
	private result?: Promise<RecordingResult>

	// audio state
	private aw: OggOpusWriter | null = null
	private aPath?: string
	private aT0 = 0 // wall clock (ms) of first audio chunk
	private aFrames = 0 // frames (per channel) written, incl. padding

	// video state
	private vOut: WriteStream | null = null
	private vSegments: string[] = []
	private vFmt: PixFmt | null = null
	private vW = 0
	private vH = 0
	private vFrames = 0
	private vWaitKey = true
	private startedAt = 0
	private warnedRaw = false

	private readonly onAudio = (pcm: Float32Array) => this.writeAudio(pcm)
	private readonly onVideo = (f: RemoteVideoFrame) => this.writeVideo(f)

	constructor(private readonly session: EventEmitter, opts: RecordOptions & { isVideo?: boolean }, log: Logger = consoleLogger) {
		super()
		this.log = log
		this.o = {
			dir: opts.dir,
			baseName: opts.baseName ?? String((session as any).callId ?? Date.now()),
			audio: opts.audio ?? true,
			video: opts.video ?? Boolean(opts.isVideo),
			sampleRate: opts.sampleRate ?? 16000,
			channels: opts.channels ?? 1,
			videoFormatOverride: opts.videoFormatOverride
		}
	}

	start(): this {
		if (this.started) return this
		this.started = true
		this.startedAt = Date.now()
		mkdirSync(this.o.dir, { recursive: true })
		if (this.o.audio) this.session.on('audio', this.onAudio)
		if (this.o.video) this.session.on('videoFrame', this.onVideo)
		return this
	}

	/** Detach, flush encoders. Safe to call more than once. */
	stop(): Promise<RecordingResult> {
		if (this.result) return this.result
		this.stopped = true
		this.session.off('audio', this.onAudio)
		this.session.off('videoFrame', this.onVideo)
		this.result = this.finalize()
		return this.result
	}

	private async finalize(): Promise<RecordingResult> {
		const audioBytes = this.aw?.bytes ?? 0
		const hadPackets = (this.aw?.packets ?? 0) > 0
		await Promise.all([
			this.aw?.close(),
			this.vOut ? new Promise<void>(r => this.vOut!.end(() => r())) : undefined
		])
		this.aw = null
		this.vOut = null

		if (this.aPath && !hadPackets && existsSync(this.aPath)) unlinkSync(this.aPath)
		const res: RecordingResult = {
			audioPath: this.aPath && hadPackets ? this.aPath : undefined,
			videoSegments: this.vSegments.filter(existsSync),
			durationMs: Date.now() - this.startedAt,
			audioBytes,
			videoFrames: this.vFrames
		}
		this.emit('finished', res)
		return res
	}

	/* ───────────────────────────────── audio ───────────────────────────────── */

	private writeAudio(pcm: Float32Array) {
		if (this.stopped || !pcm?.length) return
		const now = Date.now()
		const ch = this.o.channels
		const rate = this.o.sampleRate

		if (!this.aw) {
			this.aPath = join(this.o.dir, `${this.o.baseName}.ogg`)
			this.aw = new OggOpusWriter(this.aPath, rate, ch)
			this.aT0 = now
		}
		const chunkFrames = Math.floor(pcm.length / ch)
		const expectedEnd = Math.round(((now - this.aT0) / 1000) * rate)
		const gap = expectedEnd - this.aFrames - chunkFrames
		if (gap > rate * 0.04) { // > 40 ms: engine skipped silence -> pad it
			const pad = Math.min(gap, rate * 600)
			this.aw.writeSilence((pad / rate) * 1000)
			this.aFrames += pad
		}
		// `pcm` is a view over WASM heap memory - writePcm copies synchronously.
		this.aw.writePcm(pcm.subarray(0, chunkFrames * ch))
		this.aFrames += chunkFrames
	}

	/* ───────────────────────────────── video ───────────────────────────────── */

	private writeVideo(f: RemoteVideoFrame) {
		if (this.stopped || !f?.frameBuffer) return
		const fmt = normalizeVideoFormat(f.format, this.o.videoFormatOverride)
		if (!fmt) {
			this.log.warn?.({ format: f.format }, 'unknown remote video format; set videoFormatOverride')
			return
		}
		const data = Buffer.from(
			ArrayBuffer.isView(f.frameBuffer)
				? new Uint8Array(f.frameBuffer.buffer, f.frameBuffer.byteOffset, f.frameBuffer.byteLength)
				: new Uint8Array(f.frameBuffer)
		)

		const changed = !this.vOut || fmt !== this.vFmt || (fmt !== 'h264' && (f.width !== this.vW || f.height !== this.vH))
		if (changed) {
			if (fmt === 'h264' && !f.isKeyFrame && !this.vOut) return // must start on an IDR
			this.vOut?.end()
			this.openVideoSegment(fmt, f.width, f.height)
		}
		if (this.vWaitKey && fmt === 'h264' && !f.isKeyFrame) return
		this.vWaitKey = false

		const out = this.vOut!
		if (out.destroyed || out.writableLength > 64 * 1024 * 1024) return // disk stalled: drop
		if (fmt !== 'h264') {
			const need = expectedFrameBytes(fmt, f.width, f.height)
			if (data.length < need) return // truncated frame
			out.write(data.subarray(0, need))
		} else {
			out.write(data) // Annex-B NAL units are written as received
		}
		this.vFrames++
	}

	private openVideoSegment(fmt: PixFmt, w: number, h: number) {
		const idx = this.vSegments.length
		const suffix = idx ? `-${idx}` : ''
		const name = fmt === 'h264'
			? `${this.o.baseName}.video${suffix}.h264`
			: `${this.o.baseName}.video${suffix}.${w}x${h}.${fmt}`
		const path = join(this.o.dir, name)
		this.vSegments.push(path)
		this.vFmt = fmt; this.vW = w; this.vH = h
		this.vWaitKey = fmt === 'h264'
		if (fmt !== 'h264' && !this.warnedRaw) {
			this.warnedRaw = true
			this.log.warn?.({ fmt }, 'engine delivers RAW video; .h264 needs an encoder, so raw frames are dumped instead')
		}
		this.vOut = createWriteStream(path)
		this.vOut.on('error', () => undefined)
	}
}

export function expectedFrameBytes(fmt: Exclude<PixFmt, 'h264'>, w: number, h: number): number {
	switch (fmt) {
		case 'yuv420p': case 'nv12': case 'nv21': return Math.floor((w * h * 3) / 2)
		case 'rgba': case 'bgra': return w * h * 4
	}
}
