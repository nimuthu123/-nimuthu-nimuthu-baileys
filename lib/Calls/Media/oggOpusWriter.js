"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OggOpusWriter = void 0;
/**
 * Minimal Ogg Opus writer + libopus (opusscript) encoder. No ffmpeg.
 * Input: Float32 PCM (any chunk size) at 16/12/8/24/48 kHz, mono or stereo.
 * Output: a standard .ogg (Opus) file, 20 ms packets.
 */
const node_fs_1 = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const OpusScript = require('opusscript');
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let r = i << 24;
        for (let j = 0; j < 8; j++)
            r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
        t[i] = r >>> 0;
    }
    return t;
})();
function oggCrc(buf) {
    let crc = 0;
    for (let i = 0; i < buf.length; i++)
        crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
    return crc >>> 0;
}
const PACKETS_PER_PAGE = 25; // 0.5 s
class OggOpusWriter {
    sampleRate;
    channels;
    out;
    enc;
    frameSamples; // per channel, 20 ms
    serial = (Math.random() * 0xffffffff) >>> 0;
    seq = 0;
    pending = [];
    granule = 0; // in 48 kHz units
    carry;
    carryLen = 0;
    ended = false;
    bytes = 0;
    packets = 0;
    constructor(path, sampleRate = 16000, channels = 1) {
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.frameSamples = Math.round(sampleRate * 0.02);
        this.carry = new Int16Array(this.frameSamples * channels);
        this.enc = new OpusScript(sampleRate, channels, OpusScript.Application.VOIP);
        this.out = (0, node_fs_1.createWriteStream)(path);
        this.out.on('error', () => undefined);
        const head = Buffer.alloc(19);
        head.write('OpusHead', 0, 'latin1');
        head[8] = 1;
        head[9] = channels;
        head.writeUInt16LE(312, 10); // pre-skip (48 kHz samples)
        head.writeUInt32LE(sampleRate, 12);
        head.writeInt16LE(0, 16);
        head[18] = 0;
        this.page([head], 0, 0x02);
        const vendor = Buffer.from('baileys-calls');
        const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
        tags.write('OpusTags', 0, 'latin1');
        tags.writeUInt32LE(vendor.length, 8);
        vendor.copy(tags, 12);
        tags.writeUInt32LE(0, 12 + vendor.length);
        this.page([tags], 0, 0x00);
    }
    /** Append Float32 PCM (interleaved). Safe to pass views over WASM memory: data is copied synchronously. */
    writePcm(pcm) {
        if (this.ended)
            return;
        const ch = this.channels;
        let i = 0;
        while (i < pcm.length) {
            const room = this.carry.length - this.carryLen;
            const n = Math.min(room, pcm.length - i);
            for (let k = 0; k < n; k++) {
                const v = Math.max(-1, Math.min(1, pcm[i + k]));
                this.carry[this.carryLen + k] = v < 0 ? v * 0x8000 : v * 0x7fff;
            }
            this.carryLen += n;
            i += n;
            if (this.carryLen === this.carry.length) {
                this.encodeFrame();
                this.carryLen = 0;
            }
        }
        void ch;
    }
    /** Write `ms` of silence (used to keep wall-clock timing when the engine skips silence). */
    writeSilence(ms) {
        let frames = Math.round(ms / 20);
        const zero = new Float32Array(this.frameSamples * this.channels);
        while (frames-- > 0 && !this.ended)
            this.writePcm(zero);
    }
    encodeFrame() {
        const buf = Buffer.from(this.carry.buffer, this.carry.byteOffset, this.carry.byteLength);
        const pkt = this.enc.encode(buf, this.frameSamples);
        if (this.pending.length >= PACKETS_PER_PAGE)
            this.flush(false);
        this.pending.push(Buffer.from(pkt));
        this.packets++;
        this.granule += 960;
    }
    flush(eos) {
        if (!this.pending.length)
            return;
        // granule of a page = position after its last packet
        const g = this.granule - (eos ? 0 : 0);
        this.page(this.pending, g, eos ? 0x04 : 0x00);
        this.pending = [];
    }
    page(packets, granule, type) {
        const segs = [];
        for (const p of packets) {
            let len = p.length;
            while (len >= 255) {
                segs.push(255);
                len -= 255;
            }
            segs.push(len);
        }
        const header = Buffer.alloc(27 + segs.length);
        header.write('OggS', 0, 'latin1');
        header[4] = 0;
        header[5] = type;
        header.writeBigUInt64LE(BigInt(granule), 6);
        header.writeUInt32LE(this.serial, 14);
        header.writeUInt32LE(this.seq++, 18);
        header[26] = segs.length;
        for (let i = 0; i < segs.length; i++)
            header[27 + i] = segs[i];
        const page = Buffer.concat([header, ...packets]);
        page.writeUInt32LE(oggCrc(page), 22);
        this.out.write(page);
        this.bytes += page.length;
    }
    /** Pad the last partial frame, write the EOS page, close the file. */
    close() {
        if (this.ended)
            return Promise.resolve();
        if (this.carryLen > 0) {
            this.carry.fill(0, this.carryLen);
            this.encodeFrame();
            this.carryLen = 0;
        }
        this.ended = true;
        this.flush(true);
        try {
            this.enc.delete();
        }
        catch { /* ignore */ }
        return new Promise(res => this.out.end(() => res()));
    }
}
exports.OggOpusWriter = OggOpusWriter;
