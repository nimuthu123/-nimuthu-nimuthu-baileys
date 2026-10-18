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
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { CallRecorder, type RecordOptions, type RecordingResult } from './callRecorder'
import { type Logger, consoleLogger } from './logger'

export interface PlaybackOptions {
	/** 'opus:<file.ogg>' (pre-encoded Ogg Opus) or 'silence'. */
	audio?: string
	/** 'yuv:<file.yuv>' raw I420 frames (set width/height/fps to match the file). Video calls only. */
	video?: string
	loopAudio?: boolean
	loopVideo?: boolean
	/** Video calls: output geometry sent to the caller. */
	width?: number
	height?: number
	fps?: number
}

export interface CallMediaOptions {
	playback?: PlaybackOptions
	/** `true` => defaults into ./recordings. */
	record?: boolean | RecordOptions
}

export interface CallSessionForMedia extends EventEmitter {
	readonly callId: string
	readonly isVideo: boolean
	accept(opts?: Record<string, unknown>): Promise<void>
}

export class CallMediaHandler extends EventEmitter {
	private recorder?: CallRecorder
	private recording: Promise<RecordingResult> | null = null

	constructor(
		private readonly session: CallSessionForMedia,
		private readonly opts: CallMediaOptions = {},
		private readonly log: Logger = consoleLogger
	) {
		super()
		const rec = opts.record
		if (rec) {
			const ro: RecordOptions = rec === true ? { dir: resolve('recordings') } : rec
			// Attach BEFORE accept so we never miss the first packets.
			this.recorder = new CallRecorder(session, { ...ro, isVideo: session.isVideo }, log)
			this.recorder.on('error', e => this.emit('error', e))
			this.recorder.start()
		}
	}

	/** Accept the call and start feeding media. Resolves when accept was sent. */
	async answer(): Promise<void> {
		const p = this.opts.playback ?? {}
		const audioSource = this.pickSource(p.audio, 'silence')
		const acceptOpts: Record<string, unknown> = {
			audioSource,
			repeatAudio: p.loopAudio ?? false
		}
		if (this.session.isVideo) {
			const v = this.pickSource(p.video, undefined)
			if (v) {
				acceptOpts.videoSource = v
				acceptOpts.isCameraEnabled = true
				acceptOpts.videoLoop = p.loopVideo ?? false
				if (p.width) acceptOpts.videoWidth = p.width
				if (p.height) acceptOpts.videoHeight = p.height
				if (p.fps) acceptOpts.videoFps = p.fps
			}
		}
		acceptOpts.isMicEnabled = true
		this.log.info?.({ callId: this.session.callId, acceptOpts }, 'accepting call')
		await this.session.accept(acceptOpts)
	}

	/** Stop recording and return the files. Idempotent. */
	stop(): Promise<RecordingResult | null> {
		if (!this.recorder) return Promise.resolve(null)
		this.recording ??= this.recorder.stop()
		return this.recording
	}

	private pickSource(src: string | undefined, fallback: string | undefined): string | undefined {
		if (!src) return fallback
		if (src === 'silence') return src
		// ffmpeg-free sources only:
		//   audio: 'opus:<file.ogg>'  (pre-encoded Ogg Opus)
		//   video: 'yuv:<file.yuv>'   (pre-decoded raw I420, size/fps from playback.width/height/fps)
		const m = /^(opus|yuv):(.+)$/.exec(src)
		if (!m) {
			this.log.warn?.({ src }, 'unsupported media source (ffmpeg was removed): use opus:<file.ogg> or yuv:<file.yuv>')
			return fallback
		}
		if (/^https?:\/\//i.test(m[2])) return `${m[1]}:${m[2]}` // remote URL: streamed, not downloaded
		const abs = resolve(m[2])
		if (!existsSync(abs)) {
			this.log.warn?.({ src: abs }, 'media file not found; falling back')
			return fallback
		}
		return `${m[1]}:${abs}`
	}
}
