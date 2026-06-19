import fsp from "fs/promises";

// Canonical format of our speech clips: 24 kHz, 16-bit, mono PCM
// (see SpeechSynthesizer). One place owns these constants so the recorder,
// the duration helper, and anything else stay in lockstep.
export const SAMPLE_RATE = 24000;
export const CHANNELS = 1;
export const BIT_DEPTH = 16;
export const BYTE_RATE = (SAMPLE_RATE * CHANNELS * BIT_DEPTH) / 8; // 48000 bytes/sec
export const BLOCK_ALIGN = (CHANNELS * BIT_DEPTH) / 8; // 2 bytes/sample
export const HEADER_BYTES = 44;

/** Audio milliseconds for a given number of PCM bytes. */
export const bytesToMs = (bytes: number): number => (bytes / BYTE_RATE) * 1000;

/** PCM bytes for a given duration, kept sample-aligned. */
export const msToBytes = (ms: number): number => {
  const raw = Math.round((ms / 1000) * BYTE_RATE);
  return raw - (raw % BLOCK_ALIGN);
};

/** Pull the raw PCM out of a canonical WAV buffer (the `data` chunk). */
export function extractPcm(wav: Buffer): Buffer {
  let off = 12; // skip "RIFF"<size>"WAVE"
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "data") return wav.subarray(off + 8, off + 8 + size);
    off += 8 + size;
  }
  return wav.subarray(HEADER_BYTES); // fallback for our own fixed-layout WAVs
}

/** A canonical 44-byte WAV header for `dataLen` bytes of our PCM format. */
export function wavHeader(dataLen: number): Buffer {
  const h = Buffer.alloc(HEADER_BYTES);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataLen, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(CHANNELS, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(BYTE_RATE, 28);
  h.writeUInt16LE(BLOCK_ALIGN, 32);
  h.writeUInt16LE(BIT_DEPTH, 34);
  h.write("data", 36);
  h.writeUInt32LE(dataLen, 40);
  return h;
}

/** Wrap raw PCM bytes in a canonical WAV container (header + data). */
export function wrapPcm(pcm: Buffer): Buffer {
  return Buffer.concat([wavHeader(pcm.length), pcm]);
}

/** Playback length of a WAV file in ms, read from its `data` chunk. 0 on error. */
export async function wavDurationMs(filePath: string): Promise<number> {
  try {
    const buf = await fsp.readFile(filePath);
    return bytesToMs(extractPcm(buf).length);
  } catch {
    return 0;
  }
}
