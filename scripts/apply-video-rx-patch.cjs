#!/usr/bin/env node
/**
 * Routes REMOTE video frames from the WASM VoIP engine up to CallSession.
 *
 * Why: the stock fork's worker posts `onVideoFrameWasmToJs` messages
 * (lib/Voip/worker-bootstrap.mjs) but wasm-engine.mjs never dispatches them,
 * so inbound video is silently dropped. This patch adds:
 *   wasm-engine.mjs   -> callbacks.onVideoFrame(frame)
 *   index.mjs         -> #handleVideoFrame -> call._emitVideoFrame
 *   call-manager.mjs  -> same, for the CallManager path
 *   call-session.*    -> _emitVideoFrame -> emits "videoFrame"
 *
 * Idempotent. Usage: node patch.cjs [path/to/node_modules/@nimuthu/baliyes]
 */
const fs = require('fs'), path = require('path')
const root = process.argv[2] || path.dirname(require.resolve('@nimuthu/baliyes/package.json', { paths: [process.cwd()] }))
const voip = path.join(root, 'lib', 'Voip')
const MARK = 'baileys-calls-ext'

function patch(file, edits) {
  const p = path.join(voip, file)
  let s = fs.readFileSync(p, 'utf8')
  if (s.includes(MARK)) return console.log(`= ${file} already patched`)
  for (const [anchor, replacement, label] of edits) {
    if (!s.includes(anchor)) throw new Error(`${file}: anchor not found (${label}) - fork version differs`)
    s = s.replace(anchor, () => replacement)
  }
  fs.writeFileSync(p, s)
  console.log(`+ ${file} patched`)
}

patch('wasm-engine.mjs', [
  [`        else if (callbackName === "stopVideoCaptureJS") {
            callbacks.onVideoCaptureStop?.(data);
        }`,
`        else if (callbackName === "stopVideoCaptureJS") {
            callbacks.onVideoCaptureStop?.(data);
        }
        else if (callbackName === "onVideoFrameWasmToJs") { /* ${MARK} */
            callbacks.onVideoFrame?.(data);
        }`, 'worker dispatch'],
  [`            stopVideoCaptureJS: (data) => {
                callbacks.onVideoCaptureStop?.(data);
                return 0;
            },`,
`            stopVideoCaptureJS: (data) => {
                callbacks.onVideoCaptureStop?.(data);
                return 0;
            },
            onVideoFrameWasmToJs: (data) => { callbacks.onVideoFrame?.(data); return 0; },`, 'vm table'],
])

const handler = (lookup) => `    #handleVideoFrame = (frame, callId) => { /* ${MARK} */
        const c = ${lookup};
        if (c && !c.ended) c._emitVideoFrame?.(frame);
    };

    #handleVideoCaptureStart = (data, callId) => {`
const wire = `onVideoCaptureStart: (data) => this.#handleVideoCaptureStart(data, callId),`

patch('index.mjs', [
  [wire, wire + `\n                onVideoFrame: (frame) => this.#handleVideoFrame(frame, callId),`, 'callbacks'],
  [`    #handleVideoCaptureStart = (data, callId) => {`, handler('callId ? this.#activeCalls.get(callId) : null'), 'handler'],
])
patch('call-manager.mjs', [
  [wire, wire + `\n                    onVideoFrame: (frame) => this.#handleVideoFrame(frame, callId),`, 'callbacks'],
  [`    #handleVideoCaptureStart = (data, callId) => {`, handler('this.calls.get(callId)'), 'handler'],
])

const emit = `    _emitAudio = (pcm) => { this.emit("audio", pcm); };\n    /** @internal ${MARK} */\n    _emitVideoFrame = (frame) => { this.emit("videoFrame", frame); };`
for (const f of ['call-session.mjs', 'call-session.js'])
  patch(f, [[`    _emitAudio = (pcm) => { this.emit("audio", pcm); };`, emit, 'session emit']])
console.log('done')
