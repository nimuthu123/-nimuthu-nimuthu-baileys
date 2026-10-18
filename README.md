# @nimuthu/baliyes

A patched fork of the `@innovatorssoft/baileys` WhatsApp Web library (itself based on Baileys) that can
**answer WhatsApp voice/video calls**, **play audio/video to the caller**, and **record the call**,
with **no ffmpeg at runtime** and **no limit on concurrent calls**.

Audio and video can be played from a **local file or an http(s) URL** (streamed, never saved to disk).

> Unofficial. Not affiliated with WhatsApp or Meta. Using unofficial clients violates WhatsApp's Terms of
> Service and can get numbers banned. Use at your own risk, preferably on a spare number.

---

## What is different from upstream

| Area | Change |
|---|---|
| Package name | Renamed to `@nimuthu/baliyes` (all internal self-imports updated, including `lib/Voip/index.mjs`) |
| Concurrent calls | `voip.maxConcurrentCalls` default is `0` = **unlimited** (upstream default was `1`) |
| Call playback | `opus:<file.ogg>` plays pre-encoded Ogg Opus through an in-process decoder (no ffmpeg) |
| Video playback | `yuv:<file.yuv>` plays raw I420 frames (no ffmpeg) |
| **URL sources** | `opus:https://...` and `yuv:https://...` are **streamed over HTTP(S)**, nothing is written to disk |
| Call recording | Audio saved as Ogg Opus (`<callId>.ogg`), video as Annex-B H.264 (`<callId>.video.h264`) |
| Calls API | `attachCalls(sock, options)` extension with events: `call.received`, `call.accepted`, `call.ended`, `call.error`, `call.signal` |

---

## Requirements

- Node.js **>= 20** (URL streaming uses the built-in `fetch`)
- Prebuilt `@roamhq/wrtc` for your platform (installed automatically as a dependency)
- **Outbound and inbound UDP** to WhatsApp relay servers (port 3478 and nearby). If UDP is blocked, calls connect
  but media never flows (see [Troubleshooting](#troubleshooting))
- ffmpeg is **not** needed to run the bot. It is only used once, on any machine, to create the media files

## Install

From a local folder (the extracted zip):

```bash
npm install ../Baileys-main
```

or in `package.json`:

```json
"dependencies": { "@nimuthu/baliyes": "file:../Baileys-main" }
```

If you previously used the upstream package: `npm uninstall @innovatorssoft/baileys`.

Publishing to npm (optional, needs the `@nimuthu` scope on your npm account): `npm publish --access public`.

---

## Quick start

```js
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  attachCalls
} = require('@nimuthu/baliyes')

const GREETING_URL = 'https://your-host/greeting.ogg' // Ogg OPUS
const VIDEO_URL = ''                                   // raw I420 640x480@15, or '' for none

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    voip: { maxConcurrentCalls: 0 } // 0 = unlimited, also enables the VoIP engine
  })
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection }) => {
    if (connection !== 'open') return

    const calls = attachCalls(sock, {
      policy: () => true, // true = auto-answer every call
      defaultAccept: {
        playback: {
          audio: 'opus:' + GREETING_URL,
          video: VIDEO_URL ? 'yuv:' + VIDEO_URL : undefined,
          loopVideo: true,
          width: 640, height: 480, fps: 15
        },
        record: { dir: './recordings' }
      }
    })

    calls.on('call.received', c => console.log('incoming', c.isVideo ? 'video' : 'voice', c.from))
    calls.on('call.ended', ({ callId, reason, recording }) => console.log('ended', callId, reason, recording))
  })
}
start()
```

A complete working example with chat commands, call time limit, owner notification and pairing-code login is in
`bot.js` (shipped alongside this README).

---

## Media sources

`playback.audio` and `playback.video` accept:

| Value | Meaning |
|---|---|
| `'silence'` | Answer with silence (audio only) |
| `'opus:/path/greeting.ogg'` | Local pre-encoded **Ogg Opus** file |
| `'opus:https://host/greeting.ogg'` | Same file, **streamed from a URL** |
| `'yuv:/path/demo.yuv'` | Local raw **I420** video |
| `'yuv:https://host/demo.yuv'` | Same video, **streamed from a URL** |

Anything else (for example `mp3:`, a bare path, or `file.mp4`) is rejected with a warning and falls back to
silence / no video, because ffmpeg is no longer part of the pipeline.

### Creating the media files (once, on any PC with ffmpeg)

```bash
# audio: must be Ogg OPUS, not Vorbis
ffmpeg -i greeting.mp3 -c:a libopus -b:a 24k -ar 16000 -ac 1 greeting.ogg

# video: raw I420, resolution/fps must match playback.width/height/fps
ffmpeg -i demo.mp4 -vf scale=640:480 -r 15 -pix_fmt yuv420p demo.yuv
```

### URL streaming notes

- Implemented in `lib/Voip/url-stream.mjs` (`openSource`). It uses `fetch`, follows redirects, and pipes the
  response body into the same demuxer/frame reader used for local files.
- Looping (`loopAudio`, `loopVideo`) **re-requests the URL** each loop.
- If the host is down during a call, that call plays silence/no video. The bot does not crash.
- The URL must be directly downloadable (no login page, no HTML preview page, no expiring signed link that dies
  mid-call). GitHub raw, S3, R2 and similar work well.
- **Audio from a URL is practical** (about 24 kbit/s).
- **Video from a URL is usually not**: raw I420 at 640x480@15 is about 7 MB/s (about 55 Mbit/s) and the file size
  must be a whole multiple of `width x height x 1.5` bytes. Prefer a local `.yuv` for video.
- The Ogg file must contain an `OpusHead` header. A Vorbis `.ogg` (common in sample-file sites) will not play and
  logs `OPUS_INVALID_PACKET`. Verify at startup with the `checkAudioUrl()` helper in `bot.js`.

---

## Calls API

```ts
const calls = attachCalls(sock, { policy, defaultAccept, traceSignaling })

calls.on('call.received', call => {})            // { callId, from, callerPn, isVideo, session }
calls.on('call.accepted', handle => {})          // handle.callId, handle.session, handle.hangup(reason)
calls.on('call.ended',    ({ callId, reason, recording }) => {})
calls.on('call.error',    (err, callId) => {})
calls.on('call.signal',   s => {})               // only useful with traceSignaling

await calls.acceptCall(callId, { playback: {...}, record: {...} })
await calls.rejectCall(callId)
await handle.hangup('reason')
await calls.shutdown()                            // call on process exit / reconnect
calls.ringing                                     // currently ringing calls
```

`policy(call)` decides what happens to an incoming call: return `true` to answer immediately, `false` to reject,
or `undefined` to leave it ringing so you can call `acceptCall` yourself later (used for delayed answering).

### Playback options

| Option | Meaning |
|---|---|
| `audio` | See [Media sources](#media-sources) |
| `video` | See [Media sources](#media-sources). Only used on video calls |
| `loopAudio`, `loopVideo` | Repeat the source |
| `width`, `height`, `fps` | Must match the raw `.yuv` file |

### Recording options

`record: { dir, baseName?, audio?, video?, videoFormatOverride? }`

| Output | File |
|---|---|
| Caller audio | `<callId>.ogg` (Ogg Opus, written in-process) |
| Caller video | `<callId>.video.h264` (Annex-B, as received) |

`call.ended` gives `recording = { audioPath, videoSegments, durationMs, audioBytes, videoFrames }`.
Recording calls requires the other party's consent in many jurisdictions. Consider playing a "this call is
recorded" announcement as the greeting.

---

## Why this is not WebRTC/SDP

WhatsApp calls do not use SDP/ICE/DTLS like browser calls. Signaling is binary `<call>` stanzas, the media key
arrives Signal-encrypted inside the offer, and media goes over UDP to WhatsApp relay servers using WhatsApp's own
framing. The fork runs WhatsApp's own VoIP engine (WASM) for that, and the calls extension drives that engine.

---

## Troubleshooting

**Call is answered but there is no audio/video, then the caller hangs up after about 20 seconds.**
Typical log signs: `ice_state_changed ... "state":"failed"` for relay IPs such as `57.144.x.x:3478`,
`Bind request sent for UDP relay ... (retry 12)`, `rx_total_bytes : 0`, `No Rx traffic for ...ms`,
`accepted_but_not_connected_time_spent_ms` around 19000. The `streaming` event never fires.
This means the relays never answered, so it is a **network/UDP problem**, not a media-source problem. Try:

1. Allow `node.exe` through Windows Firewall (inbound and outbound UDP):
   `netsh advfirewall firewall add rule name="node udp out" dir=out action=allow protocol=UDP program="C:\Program Files\nodejs\node.exe"`
   and the same with `dir=in`.
2. Turn off VPN/proxy/antivirus network shields.
3. Test from another network (for example a mobile hotspot). Some ISPs/routers drop UDP 3478.
4. Check that the native module is installed: `npm ls @roamhq/wrtc`.

**Startup says "greeting URL problem: Ogg but NOT Opus".** Re-encode with `libopus` (see above).

**Startup says "HTTP 403/404".** The URL is not a direct file link, or the host blocks the request.

**Cannot find module '@nimuthu/baliyes'.** The package was not installed from the extracted folder, or `bot.js`
still requires the old name. The name is `baliyes` (b-a-l-i-y-e-s), not `baileys`.

**Log output is huge.** Set `DEBUG_VOIP = false` in `bot.js` once things work.

---

## What has and has not been verified

Verified in a test environment (no live WhatsApp account):

- All patched files pass `node --check`.
- URL streaming helper downloads the full body from a local HTTP server.
- The Ogg Opus feeder produces identical output (151 chunks for a 3 s test file) from a local file and from an
  HTTP URL, and a Vorbis file served over HTTP fails as expected.

**Not verified (needs a real call on your own network):**

- End-to-end call answering and media delivery with the renamed package.
- Inbound **video** recording: the pixel format and whether the engine sends remote frames for your account are
  unconfirmed. Unknown formats are logged (`unknown remote video format`) and skipped; raw frames, if received,
  are dumped as `<base>.video.<WxH>.<fmt>` because there is no encoder.
- Inbound audio format is assumed to be 16 kHz mono. If a recording plays at the wrong speed, set
  `record.sampleRate` / `channels`.
- Resolution changes mid-call create separate video segments (not concatenated).
- WhatsApp changes its protocol often. Expect to re-sync with upstream.

---

## File map (changed or added)

| File | Purpose |
|---|---|
| `lib/Voip/url-stream.mjs` | **New.** `openSource()` opens a path or streams an http(s) URL |
| `lib/Voip/ogg-opus-feeder.mjs` | Ogg Opus playback, now URL-aware |
| `lib/Voip/raw-video-feeder.mjs` | Raw I420 playback, now URL-aware |
| `lib/Calls/Media/callMediaHandler.js` / `src/.../callMediaHandler.ts` | Accepts `opus:`/`yuv:` sources, passes URLs through |
| `lib/Calls/Media/callRecorder.*`, `oggOpusWriter.*` | In-process call recording |
| `lib/Calls/Socket/calls.*` | `attachCalls` extension |
| `lib/Voip/index.mjs` | Loads the renamed package |
| `package.json`, `package-lock.json` | Name is `@nimuthu/baliyes` |

---

## Credits and license

Based on Baileys and the `@innovatorssoft/baileys` fork. MIT licensed, see `LICENSE`.
