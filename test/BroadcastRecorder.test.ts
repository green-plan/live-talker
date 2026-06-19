import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { BroadcastRecorder } from "../src/audio/BroadcastRecorder";
import { wrapPcm, extractPcm, msToBytes, bytesToMs, HEADER_BYTES } from "../src/utils/wav";

// A realistic shared zero-point: real beat timestamps are epoch ms, never 0.
const T0 = 1_000_000;

// Write a valid canonical WAV of `ms` of silence to disk and return its path.
// At 24 kHz/16-bit/mono, 1ms = 48 bytes, so integer-ms clips map to whole bytes.
async function makeClip(dir: string, name: string, ms: number): Promise<string> {
  const file = path.join(dir, name);
  await fsp.writeFile(file, wrapPcm(Buffer.alloc(msToBytes(ms))));
  return file;
}

const srtPathOf = (wav: string) => wav.replace(/\.wav$/i, "") + ".srt";

describe("BroadcastRecorder (disk save + game-time alignment)", () => {
  let dir: string;
  let out: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "broadcast-rec-"));
    out = path.join(dir, "broadcast.wav");
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("places each clip at its game-time anchor, padding silence between, and saves a valid WAV + SRT", async () => {
    const rec = new BroadcastRecorder(out);
    await rec.start();
    rec.seedSessionStart(T0); // shared zero-point = first beat

    rec.record(await makeClip(dir, "a.wav", 100), T0, "Alpha");        // anchor +0ms
    rec.record(await makeClip(dir, "b.wav", 100), T0 + 1000, "Bravo"); // anchor +1000ms → 900ms gap
    expect(await rec.stop()).toBe(out);

    const buf = await fsp.readFile(out);
    const pcm = extractPcm(buf);

    // Timeline: 100ms clip + 900ms silence + 100ms clip = 1100ms.
    expect(bytesToMs(pcm.length)).toBe(1100);
    // The on-disk WAV is internally consistent: header data-length matches the payload.
    expect(buf.readUInt32LE(40)).toBe(pcm.length);
    expect(pcm.length).toBe(buf.length - HEADER_BYTES);

    // Subtitles track the same timeline — Bravo's cue starts at its game-time anchor.
    const srt = await fsp.readFile(srtPathOf(out), "utf8");
    expect(srt).toContain("00:00:00,000 --> 00:00:00,100\nAlpha");
    expect(srt).toContain("00:00:01,000 --> 00:00:01,100\nBravo");
  });

  it("butts an overrunning clip against the next instead of compounding drift", async () => {
    const rec = new BroadcastRecorder(out);
    await rec.start();
    rec.seedSessionStart(T0);

    rec.record(await makeClip(dir, "a.wav", 1000), T0, "Long");      // runs to +1000ms
    rec.record(await makeClip(dir, "b.wav", 100), T0 + 500, "Next"); // anchor +500ms, but slot is taken
    await rec.stop();

    const pcm = extractPcm(await fsp.readFile(out));
    // No negative padding: 1000ms + 100ms, the overrun is absorbed once, not compounded.
    expect(bytesToMs(pcm.length)).toBe(1100);

    const srt = await fsp.readFile(srtPathOf(out), "utf8");
    expect(srt).toContain("00:00:01,000 --> 00:00:01,100\nNext"); // butted right after Long
  });

  it("omits a subtitle cue for a clip with no transcript", async () => {
    const rec = new BroadcastRecorder(out);
    await rec.start();
    rec.seedSessionStart(T0);

    rec.record(await makeClip(dir, "a.wav", 100), T0, "Alpha");
    rec.record(await makeClip(dir, "b.wav", 100), T0 + 1000); // no transcript
    await rec.stop();

    const srt = await fsp.readFile(srtPathOf(out), "utf8");
    expect(srt).toContain("Alpha");
    expect(srt.trim().split("\n\n")).toHaveLength(1); // exactly one cue block
  });
});
