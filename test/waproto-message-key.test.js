const { proto } = require('../WAProto')

describe('WebMessageInfo key', () => {
    const key = {
        remoteJid: '201016610000@s.whatsapp.net',
        fromMe: true,
        id: 'SUKIE90CB7A9B161060A'
    }

    test('should round trip the chat message key', () => {
        const encoded = proto.WebMessageInfo.encode({ key }).finish()
        const decoded = proto.WebMessageInfo.decode(encoded)

        expect(decoded.key.remoteJid).toBe(key.remoteJid)
        expect(decoded.key.fromMe).toBe(key.fromMe)
        expect(decoded.key.id).toBe(key.id)
    })

    test('should use Protocol.MessageKey and not the signal storage one', () => {
        const message = proto.WebMessageInfo.fromObject({
            key: { ...key, participant: '201016610001@s.whatsapp.net', cipherKey: 'AAAA' }
        })

        expect(message.key.participant).toBe('201016610001@s.whatsapp.net')
        expect(message.key.cipherKey).toBeUndefined()
    })
})
