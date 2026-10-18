/** Feeds synthetic media through a fake session and verifies output with ffprobe. */
import { EventEmitter } from 'node:events'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CallRecorder } from '../../lib/Calls/Media/callRecorder'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const probe = (f: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
	'stream=codec_name,codec_type,width,height,nb_frames:format=duration', '-of', 'json', f]).toString())
let failed = 0
const check = (name: string, ok: boolean, extra = '') => { console.log(ok ? 'PASS' : 'FAIL', name, extra); if (!ok) failed++ }

async function run(label: string, videoKind: 'i420' | 'h264') {
	const dir = mkdtempSync(join(tmpdir(), 'rec-'))
	const s = new EventEmitter() as any
	s.callId = label
	const rec = new CallRecorder(s, { dir, video: true, baseName: label }, { warn: console.warn, error: console.error }).start()

	// Real h264 bitstream, split into arbitrary chunks (first chunk contains SPS/PPS/IDR).
	let h264: Buffer | null = null
	if (videoKind === 'h264') {
		h264 = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2',
			'-c:v', 'libx264', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', 'pipe:1'], { maxBuffer: 1 << 26 }).stdout
	}
	const t0 = Date.now()
	let phase = 0
	// 2 s of audio: 0-0.6 s tone, 0.6-1.4 s SILENCE (no events, like the engine), 1.4-2 s tone
	for (let tMs = 0; tMs < 2000; tMs += 16) {
		const inGap = tMs >= 600 && tMs < 1400
		if (!inGap) {
			const n = 256 // 16 ms @ 16 kHz
			const pcm = new Float32Array(n)
			for (let i = 0; i < n; i++) pcm[i] = 0.4 * Math.sin((2 * Math.PI * 440 * (phase++)) / 16000)
			s.emit('audio', pcm)
		}
		if (videoKind === 'i420' && tMs % 96 === 0) {
			const w = 320, h = 240, buf = new Uint8Array((w * h * 3) / 2).fill((tMs / 8) & 255)
			s.emit('videoFrame', { frameBuffer: buf.buffer, width: w, height: h, format: 'I420', isKeyFrame: true })
		}
		if (videoKind === 'h264' && tMs === 0) {
			for (let off = 0; off < h264!.length; off += 4000)
				s.emit('videoFrame', { frameBuffer: h264!.subarray(off, off + 4000), width: 320, height: 240, format: 'H264', isKeyFrame: off === 0 })
		}
		const wait = t0 + tMs + 16 - Date.now()
		if (wait > 0) await sleep(wait)
	}
	const r = await rec.stop()
	console.log(label, JSON.stringify({ ...r, videoSegments: r.videoSegments.map(p => p.split('/').pop()) }))
	const a = probe(r.audioPath!)
	const dur = Number(a.format.duration)
	check(`${label}: mp3 exists, duration ≈2 s incl. padded silence (got ${dur.toFixed(2)})`, dur > 1.8 && dur < 2.4)
	const v = probe(r.videoSegments[0])
	check(`${label}: video is h264 320x240`, v.streams[0].codec_name === 'h264' && v.streams[0].width === 320)
	check(`${label}: muxed file has video+audio`, !!r.muxedPath &&
		probe(r.muxedPath).streams.map((x: any) => x.codec_type).sort().join() === 'audio,video')
	console.log(readdirSync(dir).join(', '))
}

(async () => {
	await run('i420', 'i420')
	await run('annexb', 'h264')
	process.exit(failed ? 1 : 0)
})()
