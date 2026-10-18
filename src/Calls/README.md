# baileys-calls-ext

Answer WhatsApp voice/video calls, play audio/video to the caller, and record what the caller says/shows,
built on the `@nimuthu/baliyes` fork you uploaded (it already contains `lib/Voip`).

## Read this first: why this is not `wrtc` + SDP

WhatsApp calls do not use SDP/ICE/DTLS. Signaling is `<call>` binary stanzas; the media key arrives
Signal-encrypted in `<offer><enc>`; media goes over UDP to WhatsApp *relay* servers using WhatsApp's own
framing. Your fork runs WhatsApp's own VoIP engine (WASM) for that, so a stand-alone `RTCPeerConnection`
cannot answer a WhatsApp call. This project therefore **extends the fork's engine** instead of replacing it.
Full wire-format notes are at the top of `src/Socket/calls.ts`.

| Your requirement | Where it lives |
|---|---|
| 1. Parse `<call><offer>`, `acceptCall` | `src/Socket/calls.ts` (`parseCallStanza`, `buildAcceptStanza`, `CallsExtension.acceptCall`); real crypto/relay handled by the fork's `Voip` engine |
| 2. Media session setup | fork's WASM engine + relay transport (not wrtc/SDP) |
| 3. Play MP3/MP4 to caller | `CallMediaHandler.answer()` → `session.accept({audioSource, videoSource})` (ffmpeg feeders in the fork) |
| 4. Record caller to mp3/mp4 | `src/Media/callRecorder.ts` (+ `patches/apply-video-rx-patch.cjs` for inbound video) |

File-name note: you asked for `webrtcHandler.ts`; it is `src/Media/callMediaHandler.ts` because it contains no WebRTC.

## Setup

System: Node >= 20, ffmpeg >= 5 **with libx264, libmp3lame, aac** (`ffmpeg -encoders | grep -E "x264|mp3lame"`).
- Debian/Ubuntu: `sudo apt install ffmpeg`   macOS: `brew install ffmpeg`
- C++ toolchain only if `@roamhq/wrtc` has no prebuilt binary for your platform:
  `sudo apt install build-essential python3` (macOS: Xcode CLT).

```bash
# (already part of this package; no extra install)
npm i                                # this project's dev deps (typescript, ts-node)
npm run patch:video                      # one-time: route remote video frames (re-run after upgrading the fork)
mkdir media && cp your.mp3 media/greeting.mp3 && cp your.mp4 media/demo.mp4
npx ts-node examples/index.ts        # scan the QR, then call this number
npm test                             # recorder smoke test (synthetic media, needs ffmpeg + ffprobe)
```

Socket config must enable VoIP: `makeWASocket({ ..., voip: { maxConcurrentCalls: 3 } })`.

## API

```ts
const calls = attachCalls(sock, { policy, defaultAccept, traceSignaling })
calls.on('call.received', call => ...)          // { callId, from, isVideo, session }
await calls.acceptCall(call.callId, { playback: {audio, video, loopAudio, loopVideo, width, height, fps},
                                      record: { dir, baseName, audio, video, videoFormatOverride } })
calls.on('call.ended', ({ recording }) => recording.audioPath / .muxedPath / .videoSegments)
await calls.rejectCall(id)    await handle.hangup()    await calls.shutdown()
```

## What was verified, and what was NOT

Verified here (no live WhatsApp account available): the patch applies idempotently and passes `node --check`;
everything typechecks with `tsc --strict` against the fork; the recorder, fed synthetic data, produces a correct
.mp3 (silence gaps padded to wall-clock), .mp4 from raw I420 frames and from an H.264 Annex-B stream, and a
muxed mp4.

**Not verified (needs a real call):**
- Inbound **video**: the worker emits `onVideoFrameWasmToJs`, but I could not confirm the engine actually
  sends remote frames for your account/call type, nor the pixel `format` string it uses. Unknown formats are
  logged (`unknown remote video format`) and skipped; set `videoFormatOverride` once you see the real value.
  Orientation is ignored (no rotation applied).
- Inbound audio format: assumed 16 kHz mono Float32 as documented in the fork README. If the mp3 plays at the
  wrong speed, set `record.sampleRate` / `channels`.
- Resolution changes mid-call create `*.video-1.mp4` segments (not auto-concatenated; muxing only for one segment).
- `acceptCall` depends on the fork's engine state; WhatsApp changes its protocol often, so expect to
  re-sync with fork updates. Unofficial clients violate WhatsApp's ToS and can get numbers banned.

## Legal

Recording calls requires consent of the other party in many jurisdictions. Play a "this call is recorded"
announcement as `playback.audio` before relying on recordings.

## Unlimited calls + ffmpeg-free playback (patch notes)

- **Unlimited concurrent calls**: default `maxConcurrentCalls` is now `0` (= unlimited; the old default was `1`).
  Set a number (e.g. `voip: { maxConcurrentCalls: 5 }`) only if you want a cap.
- **Play without ffmpeg**: pass `playback.audio = 'opus:/path/greeting.ogg'`
  (a PRE-ENCODED Ogg Opus file). `lib/Voip/ogg-opus-feeder.mjs` streams it with `fs.createReadStream`,
  demuxes Ogg pages itself, decodes with the in-process WASM `opus-decoder`, and emits exact 20 ms chunks with
  drift-corrected pacing. Create the file once, offline:
  `ffmpeg -i in.mp3 -c:a libopus -b:a 24k -ar 16000 -ac 1 greeting.ogg` (or `opusenc`).
  Supports `loopAudio`, `durationMs`, stereo/any Opus frame size.
  Limit: the WhatsApp engine only accepts raw PCM at its capture port and re-encodes Opus itself, so packets
  are decoded (cheap, in-process) rather than injected raw.

## FFmpeg removed from the call pipeline

| Direction | Format | How |
|---|---|---|
| Play audio | `opus:<file.ogg>` (pre-encoded Ogg Opus) | `lib/Voip/ogg-opus-feeder.mjs` |
| Play video | `yuv:<file.yuv>` (raw I420, size/fps = `playback.width/height/fps`) | `lib/Voip/raw-video-feeder.mjs` |
| Record audio | `<base>.ogg` (Ogg Opus, in-process libopus + own Ogg muxer) | `oggOpusWriter.ts` |
| Record video | `<base>.video.h264` (Annex-B written as received) | `callRecorder.ts` |

Make the playback files once, offline (any machine with ffmpeg):
`ffmpeg -i in.mp3 -c:a libopus -b:a 24k -ar 16000 -ac 1 greeting.ogg`
`ffmpeg -i demo.mp4 -vf scale=640:480 -r 15 -pix_fmt yuv420p demo.yuv`  (raw video is big: ~7 MB/s at 640x480@15)

Not verified without a real call: if the engine delivers RAW (not H.264) remote video, `.h264` cannot be written
without a video encoder, so raw frames are dumped as `<base>.video.<WxH>.<fmt>` and a warning is logged.
`checkFfmpeg` and mp3/mp4 muxed recording were removed. (Unrelated parts of the base package, e.g. sending
media/thumbnails, still use ffmpeg.)
