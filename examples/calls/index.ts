/**
 * examples/index.ts – answer incoming WhatsApp calls, play media to the caller,
 * record what the caller says/shows.
 *
 *   npm i && npm run patch && npx ts-node examples/index.ts
 *
 * Put ./media/greeting.mp3 (voice calls) and ./media/demo.mp4 (video calls) next to this project.
 */
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '../../lib'
import { attachCalls, checkFfmpeg } from '../../lib'

async function start() {
	const ff = await checkFfmpeg()
	if (!ff.ok) throw new Error(`ffmpeg problem, missing: ${ff.missing.join(', ')}`)

	const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
	const { version } = await fetchLatestBaileysVersion()

	const sock = makeWASocket({
		version,
		auth: state,
		printQRInTerminal: true,
		// Enables the fork's VoIP client (WASM engine). Limit concurrency to what
		// your CPU can encode in real time.
		voip: { maxConcurrentCalls: 3 }
	} as any)

	sock.ev.on('creds.update', saveCreds)
	sock.ev.on('connection.update', ({ connection, lastDisconnect }: any) => {
		if (connection === 'close') {
			const code = lastDisconnect?.error?.output?.statusCode
			if (code !== DisconnectReason.loggedOut) void start() // reconnect
			else console.error('Logged out – delete ./auth_info and re-pair')
		}
		if (connection === 'open') console.log('connected as', sock.user?.id)
	})

	const calls = attachCalls(sock as any, {
		traceSignaling: false,
		// Auto-answer policy: only these numbers, everyone else gets rejected.
		policy: call => {
			const allow = (process.env.ALLOW ?? '').split(',').filter(Boolean)
			if (allow.length === 0) return undefined // manual: decide in 'call.received'
			const who = (call.callerPn || call.from).split('@')[0].split(':')[0]
			return allow.includes(who)
		},
		defaultAccept: {
			playback: { audio: './media/greeting.mp3', video: './media/demo.mp4', loopVideo: true, width: 640, height: 480, fps: 15 },
			record: { dir: './recordings' }
		}
	})

	calls.on('call.received', async call => {
		console.log(`📞 incoming ${call.isVideo ? 'VIDEO' : 'voice'} call ${call.callId} from ${call.from}`)
		// Manual flow (when no policy decided): accept after 1 s.
		if (!process.env.ALLOW) {
			await new Promise(r => setTimeout(r, 1000))
			await calls.acceptCall(call.callId, {
				playback: { audio: './media/greeting.mp3', video: './media/demo.mp4', loopVideo: true },
				record: { dir: './recordings', baseName: `${Date.now()}_${call.callId}` }
			}).catch(e => console.error('accept failed', e))
		}
	})

	calls.on('call.accepted', h => {
		console.log(`✅ ${h.callId} accepted`)
		h.session.on('connected', () => console.log(`🟢 ${h.callId} media connected`))
		h.session.on('streaming', () => console.log(`🔊 ${h.callId} playing media`))
		// Hang up automatically after 2 minutes.
		setTimeout(() => void h.hangup('time_limit'), 120_000)
	})

	calls.on('call.ended', ({ callId, reason, recording }) => {
		console.log(`⛔ ${callId} ended (${reason})`)
		if (recording) console.log('   recordings:', recording)
	})
	calls.on('call.error', (e, id) => console.error('call error', id, e))

	for (const sig of ['SIGINT', 'SIGTERM'] as const)
		process.once(sig, async () => { await calls.shutdown(); process.exit(0) })
}

start().catch(e => { console.error(e); process.exit(1) })
