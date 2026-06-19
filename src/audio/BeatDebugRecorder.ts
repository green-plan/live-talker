import fsp from "fs/promises";
import type { Beat } from "../types/pipeline.js";
import { logger } from "../utils/logger.js";
import { type Cue, buildSrt } from "../utils/srt.js";

const log = logger.child({ service: "[BeatDebugRecorder]" });

/** How a beat was disposed of, for diagnosing "why didn't this get narrated". */
export type BeatStatus = "SENT" | "SKIPPED-all-low" | "EVICTED-capacity";

// Beats have no natural duration — give each cue a fixed span just long enough
// to read comfortably scrubbing through a video player.
const CUE_SPAN_MS = 1500;

/**
 * BeatDebugRecorder — a text-only sibling to BroadcastRecorder. Writes one SRT
 * cue per beat the pipeline ever produced, tagged with what happened to it
 * (sent to the LLM, dropped as ambient noise, or evicted under backlog), so a
 * "beat never got commented on" complaint can be checked against what was
 * actually offered to the LLM versus filtered out before reaching it.
 *
 * Must share its `sessionStart` zero-point with the paired BroadcastRecorder
 * (see `seedSessionStart`) so the two .srt files can be opened side by side
 * against the same recording and stay aligned.
 */
export class BeatDebugRecorder {
  private sessionStart = 0;
  private readonly cues: Cue[] = [];
  private readonly srtPath: string;

  constructor(srtPath: string) {
    this.srtPath = srtPath;
  }

  start(): void {
    log.info({ srtPath: this.srtPath }, "🐞 beat debug recording started");
  }

  /** Seed the shared session-start timestamp — see BroadcastRecorder.seedSessionStart. */
  seedSessionStart(ts: number): void {
    if (this.sessionStart === 0) this.sessionStart = ts;
  }

  recordBeat(beat: Beat, status: BeatStatus): void {
    if (this.sessionStart === 0) this.sessionStart = beat.timestamp;
    const startMs = beat.timestamp - this.sessionStart;
    const text = `[${status}] ${beat.type}: ${beat.summary}`;
    this.cues.push({ startMs, endMs: startMs + CUE_SPAN_MS, text });
  }

  async stop(): Promise<void> {
    if (this.cues.length === 0) return;
    // Calls can arrive slightly out of timestamp order (e.g. a SKIPPED batch
    // resolves at a different pipeline stage than a SENT one) — sort before
    // writing so the SRT reads chronologically.
    const sorted = [...this.cues].sort((a, b) => a.startMs - b.startMs);
    try {
      await fsp.writeFile(this.srtPath, buildSrt(sorted), "utf8");
      log.info({ srtPath: this.srtPath, cues: sorted.length }, "📝 beat debug track saved");
    } catch (err) {
      log.error({ err, srtPath: this.srtPath }, "failed to write beat debug track");
    }
  }
}
