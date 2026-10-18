"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallsExtension = void 0;
exports.parseCallStanza = parseCallStanza;
exports.buildPreacceptStanza = buildPreacceptStanza;
exports.buildAcceptStanza = buildAcceptStanza;
exports.buildRejectStanza = buildRejectStanza;
exports.attachCalls = attachCalls;
const node_events_1 = require("node:events");
const node_crypto_1 = require("node:crypto");
const callMediaHandler_1 = require("../Media/callMediaHandler");
const logger_1 = require("../Media/logger");
const KNOWN = new Set([
    'offer', 'preaccept', 'accept', 'reject', 'terminate', 'relaylatency',
    'transport', 'mute_v2', 'video', 'interruption', 'enc_rekey', 'offer_notice'
]);
/**
 * Parse a raw `<call>` stanza (as delivered by `sock.ws.on('CB:call', …)`).
 * Returns null if the node is not a call stanza or has no verb child.
 */
function parseCallStanza(node) {
    if (!node || node.tag !== 'call' || !Array.isArray(node.content))
        return null;
    const verb = node.content.find(c => c && typeof c.tag === 'string');
    if (!verb)
        return null;
    const kids = Array.isArray(verb.content) ? verb.content : [];
    // A video call advertises a <video> child inside the offer.
    const isVideo = kids.some(k => k.tag === 'video');
    return {
        kind: (KNOWN.has(verb.tag) ? verb.tag : 'unknown'),
        tag: verb.tag,
        callId: verb.attrs['call-id'] ?? '',
        callCreator: verb.attrs['call-creator'] ?? node.attrs.from ?? '',
        from: node.attrs.from ?? '',
        timestamp: node.attrs.t ? Number(node.attrs.t) : undefined,
        isVideo,
        reason: verb.attrs.reason,
        groupJid: verb.attrs['group-jid'],
        raw: node
    };
}
/* ───────────────────────────── stanza builders ───────────────────────────── */
const stanzaId = () => (0, node_crypto_1.randomBytes)(16).toString('hex').toUpperCase();
/** <preaccept>: tells the caller our codec capabilities; phone shows "Ringing". */
function buildPreacceptStanza(callId, callCreator, isVideo) {
    const content = [{ tag: 'audio', attrs: { rate: '16000', enc: 'opus' } }];
    if (isVideo) {
        content.push({
            tag: 'video',
            attrs: { screen_width: '1080', screen_height: '2400', dec: 'H264,H265,AV1', device_orientation: '0' }
        });
    }
    content.push({ tag: 'encopt', attrs: { keygen: '2' } }, { tag: 'capability', attrs: { ver: '1' } });
    return {
        tag: 'call',
        attrs: { to: callCreator, id: stanzaId() },
        content: [{ tag: 'preaccept', attrs: { 'call-id': callId, 'call-creator': callCreator }, content }]
    };
}
/**
 * <accept>. NOTE: sending this without a running media engine that holds the
 * derived call key gives you a call that is "answered" but silent.
 */
function buildAcceptStanza(selfJid, callId, callCreator, isVideo) {
    const content = [{ tag: 'audio', attrs: { rate: '16000', enc: 'opus' } }];
    if (isVideo)
        content.push({ tag: 'video', attrs: { dec: 'H264,AV1', device_orientation: '1' } });
    content.push({ tag: 'net', attrs: { medium: '2' } }, { tag: 'encopt', attrs: { keygen: '2' } });
    return {
        tag: 'call',
        attrs: { from: selfJid, to: callCreator, id: stanzaId() },
        content: [{ tag: 'accept', attrs: { 'call-id': callId, 'call-creator': callCreator }, content }]
    };
}
function buildRejectStanza(selfJid, callId, callCreator) {
    return {
        tag: 'call',
        attrs: { from: selfJid, to: callCreator },
        content: [{ tag: 'reject', attrs: { 'call-id': callId, 'call-creator': callCreator, count: '0' } }]
    };
}
class CallsExtension extends node_events_1.EventEmitter {
    sock;
    opts;
    sessions = new Map();
    active = new Map();
    log;
    constructor(sock, opts = {}) {
        super();
        this.sock = sock;
        this.opts = opts;
        this.log = opts.logger ?? logger_1.consoleLogger;
        // NOTE: registering a 'call.incoming' listener is also what makes the fork
        // lazily start its VoIP client (see messages-recv.js: listenerCount check).
        sock.ev.on('call.incoming', (s) => void this.onIncoming(s));
        if (opts.traceSignaling && sock.ws) {
            sock.ws.on('CB:call', (node) => {
                const sig = parseCallStanza(node);
                if (sig)
                    this.emit('call.signal', sig);
            });
        }
    }
    /** Calls that are ringing (not yet accepted/rejected). */
    get ringing() { return [...this.sessions.values()]; }
    /** Calls we have accepted and that have not ended. */
    get activeCalls() { return [...this.active.values()]; }
    async onIncoming(session) {
        const callId = session.callId;
        if (this.sessions.has(callId) || this.active.has(callId)) {
            this.log.debug?.({ callId }, 'duplicate incoming_ringing ignored');
            return;
        }
        const call = {
            callId,
            from: session.callCreator || session.peerJid,
            callerPn: session.callerPn,
            isVideo: session.isVideo,
            isWaiting: session.isWaiting,
            session
        };
        this.sessions.set(callId, call);
        session.once('ended', () => this.sessions.delete(callId));
        session.once('rejected', () => this.sessions.delete(callId));
        this.emit('call.received', call);
        try {
            const verdict = await this.opts.policy?.(call);
            if (verdict === true)
                await this.acceptCall(callId, this.opts.defaultAccept);
            else if (verdict === false)
                await this.rejectCall(callId);
        }
        catch (e) {
            this.emit('call.error', e, callId);
        }
    }
    /**
     * Accept an incoming call.
     *
     * With a live VoIP session (normal case) this runs the full pipeline:
     * preaccept/accept stanzas, key derivation, relay connect, then starts the
     * media handler (playback + recording).
     */
    async acceptCall(callId, options = {}) {
        const existing = this.active.get(callId);
        if (existing)
            return existing;
        const call = this.sessions.get(callId);
        if (!call) {
            // No engine session → signaling-only fallback. Be loud about it.
            this.log.warn?.({ callId }, 'no VoIP session for this call id; sending a bare <accept> – the call will have NO media');
            await this.sock.acceptCall(callId, undefined, false);
            throw new Error(`No VoIP session for call ${callId}; sent bare accept only`);
        }
        const media = new callMediaHandler_1.CallMediaHandler(call.session, { ...this.opts.defaultAccept, ...options }, this.log);
        this.sessions.delete(callId);
        let finish;
        const done = new Promise(r => (finish = r));
        const handle = {
            callId,
            session: call.session,
            media,
            done,
            hangup: async (reason = 'hangup') => {
                if (!call.session.ended)
                    await call.session.end(reason).catch(() => undefined);
                return media.stop();
            }
        };
        this.active.set(callId, handle);
        call.session.once('ended', async (reason) => {
            let recording = null;
            try {
                recording = await media.stop();
            }
            catch (e) {
                this.emit('call.error', e, callId);
            }
            this.active.delete(callId);
            this.emit('call.ended', { callId, reason, recording });
            finish({ reason, recording });
        });
        try {
            await media.answer();
        }
        catch (e) {
            this.active.delete(callId);
            await media.stop().catch(() => undefined);
            throw e;
        }
        this.emit('call.accepted', handle);
        return handle;
    }
    /** Reject a ringing call. */
    async rejectCall(callId, reason = 'declined') {
        const call = this.sessions.get(callId);
        this.sessions.delete(callId);
        if (call)
            return call.session.reject(reason);
        // Fallback to the socket's own stanza-level reject.
        await this.sock.rejectCall(callId, undefined, reason);
    }
    /** Hang up all active calls and wait for recordings to finalize. */
    async shutdown() {
        await Promise.allSettled([...this.active.values()].map(h => h.hangup('shutdown')));
    }
}
exports.CallsExtension = CallsExtension;
/** Attach call support to a Baileys socket created by the fork. */
function attachCalls(sock, opts) {
    return new CallsExtension(sock, opts);
}
