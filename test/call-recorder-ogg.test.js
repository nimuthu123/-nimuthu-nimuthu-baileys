const { CallRecorder } = require('../lib/Calls/Media/callRecorder')
const { EventEmitter } = require('events')
const fs = require('fs'), os = require('os'), path = require('path')

test('records audio as Ogg Opus and video as raw .h264, no ffmpeg', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'))
  const s = new EventEmitter(); s.callId = 'x'
  const r = new CallRecorder(s, { dir, isVideo: true }).start()
  for (let i = 0; i < 100; i++) s.emit('audio', new Float32Array(320).fill(0.2))
  s.emit('videoFrame', { frameBuffer: Buffer.from([0, 0, 0, 1, 0x65, 1]), width: 640, height: 480, format: 'h264', isKeyFrame: true })
  const res = await r.stop()
  expect(res.audioPath.endsWith('.ogg')).toBe(true)
  expect(fs.readFileSync(res.audioPath).subarray(0, 4).toString()).toBe('OggS')
  expect(res.videoSegments[0].endsWith('.h264')).toBe(true)
}, 15000)
