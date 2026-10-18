export declare class OggOpusWriter {
    readonly sampleRate: number;
    readonly channels: number;
    private readonly out;
    private readonly enc;
    private readonly frameSamples;
    private readonly serial;
    private seq;
    private pending;
    private granule;
    private carry;
    private carryLen;
    private ended;
    bytes: number;
    packets: number;
    constructor(path: string, sampleRate?: number, channels?: number);
    /** Append Float32 PCM (interleaved). Safe to pass views over WASM memory: data is copied synchronously. */
    writePcm(pcm: Float32Array): void;
    /** Write `ms` of silence (used to keep wall-clock timing when the engine skips silence). */
    writeSilence(ms: number): void;
    private encodeFrame;
    private flush;
    private page;
    /** Pad the last partial frame, write the EOS page, close the file. */
    close(): Promise<void>;
}
