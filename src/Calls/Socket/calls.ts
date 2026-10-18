/**
 * src/Socket/calls.ts
 *
 * Call-signaling helpers + a high-level `attachCalls(sock)` extension for the
 * @nimuthu/baliyes fork (the one that ships `lib/Voip`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW WHATSAPP CALLS ACTUALLY WORK (read this before changing anything)
 * ─────────────────────────────────────────────────────────────────────────────
 * WhatsApp does NOT negotiate calls with SDP / RTCPeerConnection. The flow is:
 *
 *  1. Signaling = ordinary Baileys binary-node ("stanza") traffic on the same
 *     websocket as messages. Everything is a <call> stanza with ONE child whose
 *     tag is the signaling verb:
 *
 *       <call from="<peer>@s.whatsapp.net" id="<stanza id>" t="<unix ts>">
 *         <offer call-id="<HEX>" call-creator="<peer jid>">
 *           <audio enc="opus" rate="16000"/>      one per supported codec/rate
 *           <video dec="H264,..." orientation=…/> only for video calls
 *           <net medium="2"/>                      network type hint
 *           <capability ver="1">…</capability>     feature bitmap (binary)
 *           <enc type="pkmsg|msg" v="2">…</enc>    Signal-encrypted 32-byte CALL KEY
 *           <relay …>                              relay endpoints + tokens (STUN-ish)
 *         </offer>
 *       </call>
 *
 *     Verbs: offer, preaccept, accept, reject, terminate, relaylatency,
 *            transport, mute_v2, video, interruption, enc_rekey, offer_notice…
 *
 *  2. The 32-byte call key arrives Signal-encrypted inside <offer><enc>. Media
 *     keys (SRTP-like) are derived from it with HKDF. This is why you cannot
 *     answer by hand-writing an SDP: the answer is the <accept> stanza PLUS a
 *     live media engine that already holds the derived keys.
 *
 *  3. Media does not flow peer-to-peer over ICE/DTLS. It goes over UDP to the
 *     WhatsApp *relay* endpoints from <relay>, framed with WhatsApp's own
 *     STUN-like protocol and encrypted with the derived keys. The fork runs
 *     WhatsApp's own VoIP engine compiled to WASM (lib/Voip/wasm-engine.mjs) and
 *     a UDP relay transport (lib/Voip/relay-transport.js) for that part.
 *
 * Consequence: `wrtc` / RTCPeerConnection cannot terminate a WhatsApp call, and
 * hand-built <accept> stanzas alone produce a call that "connects" with no
 * media. The correct design is therefore:
 *
 *      this file  : typed events, stanza parsing, policy (auto-accept etc.)
 *      Voip (WASM): key derivation, relay transport, codecs, jitter buffer
 *      Media/*    : ffmpeg-free: Ogg Opus / raw I420 in, Ogg Opus / H.264 out
 *
 * The raw stanza builders below mirror what the fork sends; they are exported
 * for observability / manual fallbacks, and are what `acceptCall` degrades to
 * (with a loud warning) when the VoIP engine has no session for the call id.
 */

import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { CallMediaHandler, type CallMediaOptions } from '../Media/callMediaHandler'
import type { RecordingResult } from '../Media/callRecorder'
import { type Logger, consoleLogger } from '../Media/logger'

/* ────────────────────────────── stanza types ────────────────────────────── */

export interface CallBinaryNode {
	tag: string
	attrs: Record<string, string>
	content?: CallBinaryNode[] | Uint8Array | string
}

export type CallSignalKind =
	| 'offer' | 'preaccept' | 'accept' | 'reject' | 'terminate'
	| 'relaylatency' | 'transport' | 'mute_v2' | 'video' | 'interruption'
	| 'enc_rekey' | 'offer_notice' | 'unknown'

export interface ParsedCallSignal {
	kind: CallSignalKind
	/** Raw verb tag, useful when `kind === 'unknown'`. */
	tag: string
	callId: string
	/** JID of whoever started the call (the party that owns the call-id). */
	callCreator: string
	/** JID the stanza came from. */
	from: string
	/** Unix seconds from the `t` attribute, if present. */
	timestamp?: number
	isVideo: boolean
	/** `terminate`/`reject` carry a reason attribute. */
	reason?: string
	/** Group call marker (`group-jid` attribute on the verb node). */
	groupJid?: string
	raw: CallBinaryNode
}

const KNOWN: ReadonlySet<string> = new Set([
	'offer', 'preaccept', 'accept', 'reject', 'terminate', 'relaylatency',
	'transport', 'mute_v2', 'video', 'interruption', 'enc_rekey', 'offer_notice'
])

/**
 * Parse a raw `<call>` stanza (as delivered by `sock.ws.on('CB:call', …)`).
 * Returns null if the node is not a call stanza or has no verb child.
 */
export function parseCallStanza(node: CallBinaryNode): ParsedCallSignal | null {
	if (!node || node.tag !== 'call' || !Array.isArray(node.content)) return null
	const verb = node.content.find(c => c && typeof c.tag === 'string')
	if (!verb) return null

	const kids = Array.isArray(verb.content) ? verb.content : []
	// A video call advertises a <video> child inside the offer.
	const isVideo = kids.some(k => k.tag === 'video')

	return {
		kind: (KNOWN.has(verb.tag) ? verb.tag : 'unknown') as CallSignalKind,
		tag: verb.tag,
		callId: verb.attrs['call-id'] ?? '',
		callCreator: verb.attrs['call-creator'] ?? node.attrs.from ?? '',
		from: node.attrs.from ?? '',
		timestamp: node.attrs.t ? Number(node.attrs.t) : undefined,
		isVideo,
		reason: verb.attrs.reason,
		groupJid: verb.attrs['group-jid'],
		raw: node
	}
}

/* ───────────────────────────── stanza builders ───────────────────────────── */

const stanzaId = () => randomBytes(16).toString('hex').toUpperCase()

/** <preaccept>: tells the caller our codec capabilities; phone shows "Ringing". */
export function buildPreacceptStanza(callId: string, callCreator: string, isVideo: boolean): CallBinaryNode {
	const content: CallBinaryNode[] = [{ tag: 'audio', attrs: { rate: '16000', enc: 'opus' } }]
	if (isVideo) {
		content.push({
			tag: 'video',
			attrs: { screen_width: '1080', screen_height: '2400', dec: 'H264,H265,AV1', device_orientation: '0' }
		})
	}
	content.push({ tag: 'encopt', attrs: { keygen: '2' } }, { tag: 'capability', attrs: { ver: '1' } })
	return {
		tag: 'call',
		attrs: { to: callCreator, id: stanzaId() },
		content: [{ tag: 'preaccept', attrs: { 'call-id': callId, 'call-creator': callCreator }, content }]
	}
}

/**
 * <accept>. NOTE: sending this without a running media engine that holds the
 * derived call key gives you a call that is "answered" but silent.
 */
export function buildAcceptStanza(selfJid: string, callId: string, callCreator: string, isVideo: boolean): CallBinaryNode {
	const content: CallBinaryNode[] = [{ tag: 'audio', attrs: { rate: '16000', enc: 'opus' } }]
	if (isVideo) content.push({ tag: 'video', attrs: { dec: 'H264,AV1', device_orientation: '1' } })
	content.push({ tag: 'net', attrs: { medium: '2' } }, { tag: 'encopt', attrs: { keygen: '2' } })
	return {
		tag: 'call',
		attrs: { from: selfJid, to: callCreator, id: stanzaId() },
		content: [{ tag: 'accept', attrs: { 'call-id': callId, 'call-creator': callCreator }, content }]
	}
}

export function buildRejectStanza(selfJid: string, callId: string, callCreator: string): CallBinaryNode {
	return {
		tag: 'call',
		attrs: { from: selfJid, to: callCreator },
		content: [{ tag: 'reject', attrs: { 'call-id': callId, 'call-creator': callCreator, count: '0' } }]
	}
}

/* ───────────────────────────── extension layer ───────────────────────────── */

/** The slice of the fork's session object we rely on (see lib/Voip/index.d.ts). */
export interface VoipSessionLike extends EventEmitter {
	readonly callId: string
	readonly peerJid: string
	readonly callCreator: string
	readonly callerPn: string
	readonly isVideo: boolean
	readonly ended: boolean
	readonly isWaiting: boolean
	accept(opts?: Record<string, unknown>): Promise<void>
	reject(reason?: string): Promise<void>
	end(reason?: string): Promise<void>
}

/** Minimal socket surface used here – keeps us decoupled from fork typings. */
export interface CallsSocketLike {
	ev: { on(event: string, fn: (...a: any[]) => void): unknown; off?(event: string, fn: (...a: any[]) => void): unknown }
	ws?: { on(event: string, fn: (...a: any[]) => void): unknown }
	authState?: { creds: { me?: { id: string } } }
	acceptCall(callId: string, callFromOrOptions?: any, isVideo?: boolean, options?: any): Promise<any>
	rejectCall(callId: string, callFrom?: string, reason?: string): Promise<void>
	endCall?(callId: string): Promise<void>
}

export interface IncomingCall {
	callId: string
	/** JID of the caller (may be a @lid JID on newer accounts). */
	from: string
	/** Caller phone number when known (LID accounts), else ''. */
	callerPn: string
	isVideo: boolean
	/** True if the engine queued the call because maxConcurrentCalls was reached. */
	isWaiting: boolean
	session: VoipSessionLike
}

export interface AcceptOptions extends CallMediaOptions {}

export interface ActiveCallHandle {
	callId: string
	session: VoipSessionLike
	media: CallMediaHandler
	/** Hang up, finalize recordings, resolve with file paths. */
	hangup(reason?: string): Promise<RecordingResult | null>
	/** Resolves when the call ends for any reason. */
	done: Promise<{ reason: string; recording: RecordingResult | null }>
}

export interface CallsExtensionOptions {
	logger?: Logger
	/**
	 * Called for every incoming call. Return true to auto-accept (using
	 * `defaultAccept`), false to auto-reject, undefined to leave it ringing so
	 * your own `call.received` handler decides.
	 */
	policy?: (call: IncomingCall) => boolean | undefined | Promise<boolean | undefined>
	/** Used when `policy` returns true. */
	defaultAccept?: AcceptOptions
	/** Emit parsed raw signaling (`call.signal`) for debugging. Default false. */
	traceSignaling?: boolean
}

export interface CallsExtensionEvents {
	'call.received': (call: IncomingCall) => void
	'call.accepted': (handle: ActiveCallHandle) => void
	'call.ended': (info: { callId: string; reason: string; recording: RecordingResult | null }) => void
	'call.signal': (signal: ParsedCallSignal) => void
	'call.error': (err: Error, callId?: string) => void
}

export declare interface CallsExtension {
	on<K extends keyof CallsExtensionEvents>(ev: K, fn: CallsExtensionEvents[K]): this
	once<K extends keyof CallsExtensionEvents>(ev: K, fn: CallsExtensionEvents[K]): this
	off<K extends keyof CallsExtensionEvents>(ev: K, fn: CallsExtensionEvents[K]): this
	emit<K extends keyof CallsExtensionEvents>(ev: K, ...a: Parameters<CallsExtensionEvents[K]>): boolean
}

export class CallsExtension extends EventEmitter {
	private readonly sessions = new Map<string, IncomingCall>()
	private readonly active = new Map<string, ActiveCallHandle>()
	private readonly log: Logger

	constructor(private readonly sock: CallsSocketLike, private readonly opts: CallsExtensionOptions = {}) {
		super()
		this.log = opts.logger ?? consoleLogger
		// NOTE: registering a 'call.incoming' listener is also what makes the fork
		// lazily start its VoIP client (see messages-recv.js: listenerCount check).
		sock.ev.on('call.incoming', (s: VoipSessionLike) => void this.onIncoming(s))

		if (opts.traceSignaling && sock.ws) {
			sock.ws.on('CB:call', (node: CallBinaryNode) => {
				const sig = parseCallStanza(node)
				if (sig) this.emit('call.signal', sig)
			})
		}
	}

	/** Calls that are ringing (not yet accepted/rejected). */
	get ringing(): IncomingCall[] { return [...this.sessions.values()] }
	/** Calls we have accepted and that have not ended. */
	get activeCalls(): ActiveCallHandle[] { return [...this.active.values()] }

	private async onIncoming(session: VoipSessionLike) {
		const callId = session.callId
		if (this.sessions.has(callId) || this.active.has(callId)) {
			this.log.debug?.({ callId }, 'duplicate incoming_ringing ignored')
			return
		}
		const call: IncomingCall = {
			callId,
			from: session.callCreator || session.peerJid,
			callerPn: session.callerPn,
			isVideo: session.isVideo,
			isWaiting: session.isWaiting,
			session
		}
		this.sessions.set(callId, call)
		session.once('ended', () => this.sessions.delete(callId))
		session.once('rejected', () => this.sessions.delete(callId))

		this.emit('call.received', call)

		try {
			const verdict = await this.opts.policy?.(call)
			if (verdict === true) await this.acceptCall(callId, this.opts.defaultAccept)
			else if (verdict === false) await this.rejectCall(callId)
		} catch (e) {
			this.emit('call.error', e as Error, callId)
		}
	}

	/**
	 * Accept an incoming call.
	 *
	 * With a live VoIP session (normal case) this runs the full pipeline:
	 * preaccept/accept stanzas, key derivation, relay connect, then starts the
	 * media handler (playback + recording).
	 */
	async acceptCall(callId: string, options: AcceptOptions = {}): Promise<ActiveCallHandle> {
		const existing = this.active.get(callId)
		if (existing) return existing

		const call = this.sessions.get(callId)
		if (!call) {
			// No engine session → signaling-only fallback. Be loud about it.
			this.log.warn?.({ callId },
				'no VoIP session for this call id; sending a bare <accept> – the call will have NO media')
			await this.sock.acceptCall(callId, undefined, false)
			throw new Error(`No VoIP session for call ${callId}; sent bare accept only`)
		}

		const media = new CallMediaHandler(call.session, { ...this.opts.defaultAccept, ...options }, this.log)
		this.sessions.delete(callId)

		let finish!: (v: { reason: string; recording: RecordingResult | null }) => void
		const done = new Promise<{ reason: string; recording: RecordingResult | null }>(r => (finish = r))

		const handle: ActiveCallHandle = {
			callId,
			session: call.session,
			media,
			done,
			hangup: async (reason = 'hangup') => {
				if (!call.session.ended) await call.session.end(reason).catch(() => undefined)
				return media.stop()
			}
		}
		this.active.set(callId, handle)

		call.session.once('ended', async (reason: string) => {
			let recording: RecordingResult | null = null
			try { recording = await media.stop() } catch (e) { this.emit('call.error', e as Error, callId) }
			this.active.delete(callId)
			this.emit('call.ended', { callId, reason, recording })
			finish({ reason, recording })
		})

		try {
			await media.answer()
		} catch (e) {
			this.active.delete(callId)
			await media.stop().catch(() => undefined)
			throw e
		}
		this.emit('call.accepted', handle)
		return handle
	}

	/** Reject a ringing call. */
	async rejectCall(callId: string, reason = 'declined'): Promise<void> {
		const call = this.sessions.get(callId)
		this.sessions.delete(callId)
		if (call) return call.session.reject(reason)
		// Fallback to the socket's own stanza-level reject.
		await this.sock.rejectCall(callId, undefined, reason)
	}

	/** Hang up all active calls and wait for recordings to finalize. */
	async shutdown(): Promise<void> {
		await Promise.allSettled([...this.active.values()].map(h => h.hangup('shutdown')))
	}
}

/** Attach call support to a Baileys socket created by the fork. */
export function attachCalls(sock: CallsSocketLike, opts?: CallsExtensionOptions): CallsExtension {
	return new CallsExtension(sock, opts)
}
