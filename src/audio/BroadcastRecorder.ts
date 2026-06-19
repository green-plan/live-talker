import fsp from "fs/promises";
import type { FileHandle } from "fs/promises";
import { logger } from "../utils/logger.js";
import { HEADER_BYTES, bytesToMs, msToBytes, extractPcm, wavHeader } from "../utils/wav.js";
import { type Cue, buildSrt } from "../utils/srt.js";

const log = logger.child({ service: "[BroadcastRecorder]" });

/**
 * BroadcastRecorder — stitches every aired clip into one continuous WAV that
 * tracks the GAME timeline: each clip is placed at the offset of its anchorTs
 * (the moment its events actually happened), not the wall-clock moment the
 * pipeline finished rendering it. This keeps the recording aligned to a fixed
 * offset against a separately delayed video feed even when the text/TTS
 * pipeline falls behind or catches up — only the game-time spacing between
 * clips matters, not how long they took to produce.
 *
 * Writes via positional file I/O and re-patches the WAV header after every clip,
 * so the file on disk is always valid even if the process is killed mid-session.
 */
export class BroadcastRecorder {
  private fh: FileHandle | null = null;
  private dataBytes = 0;
  private sessionStart = 0; // wall-clock of the first aired clip
  private streamedMs = 0;   // audio written so far (silence + clips)
  private chain: Promise<void> = Promise.resolve(); // serialize appends
  private readonly cues: Cue[] = []; // subtitle cues, aligned to the broadcast timeline
  private readonly filePath: string;
  private readonly srtPath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.srtPath = filePath.replace(/\.wav$/i, "") + ".srt";
  }

  async start(): Promise<void> {
    this.fh = await fsp.open(this.filePath, "w");
    await this.fh.write(wavHeader(0), 0, HEADER_BYTES, 0);
    log.info({ filePath: this.filePath }, "🎙️ broadcast recording started");
  }

  /**
   * Seed the session-start timestamp before the first clip arrives, so this
   * recording's timeline and a sibling BeatDebugRecorder's timeline share the
   * same zero point (otherwise each would independently latch onto its own
   * first-seen timestamp, and a beat that's skipped/evicted before the first
   * aired clip would silently shift the two timelines apart). No-op once a
   * clip has already been recorded.
   */
  seedSessionStart(ts: number): void {
    if (this.sessionStart === 0) this.sessionStart = ts;
  }

  /** Record a clip at its game-time anchor (anchorTs), not when it actually aired. Fire-and-forget. */
  record(clipPath: string, anchorTs: number, transcript?: string): void {
    this.chain = this.chain
      .then(() => this.append(clipPath, anchorTs, transcript))
      .catch(err => log.error({ err, clipPath }, "failed to record clip"));
  }

  private async append(clipPath: string, anchorTs: number, transcript?: string): Promise<void> {
    if (!this.fh) return;
    const pcm = extractPcm(await fsp.readFile(clipPath));
    if (this.sessionStart === 0) this.sessionStart = anchorTs;

    // Pad silence so the clip lands at its game-time offset from the first call.
    // If a prior clip ran long enough to eat into this gap, gapMs goes negative
    // and we just butt the clips together — a one-off bleed beats compounding
    // the discrepancy onto every clip after it.
    const gapMs = (anchorTs - this.sessionStart) - this.streamedMs;
    if (gapMs > 1) {
      const silence = Buffer.alloc(msToBytes(gapMs));
      await this.writeAt(silence);
    }
    // The clip starts at the current play head and runs for its own length —
    // record a subtitle cue spanning exactly that window so the .srt aligns
    // perfectly with the stitched WAV.
    const startMs = this.streamedMs;
    await this.writeAt(pcm);
    const text = transcript?.trim();
    if (text) this.cues.push({ startMs, endMs: this.streamedMs, text });
    // Keep the header valid after every clip in case of an unclean exit.
    await this.fh.write(wavHeader(this.dataBytes), 0, HEADER_BYTES, 0);
  }

  private async writeAt(buf: Buffer): Promise<void> {
    if (buf.length === 0) return;
    await this.fh!.write(buf, 0, buf.length, HEADER_BYTES + this.dataBytes);
    this.dataBytes += buf.length;
    this.streamedMs += bytesToMs(buf.length);
  }

  async stop(): Promise<string | null> {
    await this.chain;
    if (!this.fh) return null;
    await this.fh.write(wavHeader(this.dataBytes), 0, HEADER_BYTES, 0);
    await this.fh.close();
    this.fh = null;

    // Drop a subtitle track next to the WAV, aligned to the same timeline.
    if (this.cues.length > 0) {
      try {
        await fsp.writeFile(this.srtPath, buildSrt(this.cues), "utf8");
        log.info({ srtPath: this.srtPath, cues: this.cues.length }, "📝 subtitle track saved");
      } catch (err) {
        log.error({ err, srtPath: this.srtPath }, "failed to write subtitle track");
      }
    }

    log.info(
      { filePath: this.filePath, durationMs: Math.round(bytesToMs(this.dataBytes)) },
      "🎬 broadcast recording saved"
    );
    return this.filePath;
  }
}
