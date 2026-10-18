import { OggOpusFeeder, isOggOpusSource } from "../lib/Voip/ogg-opus-feeder.mjs";
import { fileURLToPath } from "node:url";
const file = fileURLToPath(new URL("./fixtures/tone-440.ogg", import.meta.url));

test("plays pre-encoded Ogg Opus as exact 20 ms chunks, no ffmpeg", async () => {
  expect(isOggOpusSource("opus:" + file)).toBe(true);
  const chunks = [];
  await new Promise((done) => {
    const f = new OggOpusFeeder(16000, 1, 320, (c) => chunks.push(c), "opus:" + file, done, { durationMs: 1000 });
    f.start();
  });
  expect(chunks.length).toBe(50);
  expect(chunks.every((c) => c.length === 320)).toBe(true);
  expect(Math.max(...chunks.flatMap((c) => [...c]))).toBeGreaterThan(0.05);
});
