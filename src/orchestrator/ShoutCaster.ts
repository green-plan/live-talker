import fs from "fs/promises";
import type {
  OrchestratorConfig,
  Passage,
  PlannedClip,
  RenderedClip,
  SealedBatch,
} from "../types/pipeline.js";
import type { GameSnapshot } from "../types/game.js";
import { GameEventBuffer } from "../game/GameEventBuffer.js";
import { BeatBatcher } from "./BeatBatcher.js";
import { CentralState } from "../game/cs2/CentralState.js";
import { BeatDetector } from "../game/cs2/BeatDetector.js";
import { AudioPlayer } from "../infra/AudioPlayer.js";
import type { BroadcastRecorder } from "../audio/BroadcastRecorder.js";
import type { BeatDebugRecorder } from "../audio/BeatDebugRecorder.js";
import type { ICommentaryWriter, ISpeechSynthesizer } from "../synthesis/contracts.js";
import { Pool } from "../utils/pool.js";
import { wavDurationMs } from "../utils/wav.js";
import { logger } from "../utils/logger.js";
import { batchTrace, formatClock } from "../utils/time.js";

const log = logger.child({ service: "[Shoutcast]" });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Rendered slot: a finished clip, or FAILED (synthesis produced nothing) so the
// conductor can skip the index instead of waiting on it forever.
type RenderedSlot = RenderedClip | "FAILED";

// Keep a generous passage history so `passageHistoryCount` slices have headroom.
const MAX_PASSAGE_HISTORY = 100;

/**
 * ShoutCaster — the delayed-broadcast orchestrator.
 *
 * Beats accumulate into time-windowed batches (BeatBatcher). Each sealed batch is
 * narrated as one storyteller passage by a SEQUENTIAL text stage (so the story
 * builds on itself and never repeats), rendered to audio by a PARALLEL speech
 * pool, and finally aired by the Conductor — a play head running a fixed `delayMs`
 * behind real time (matching the OBS feed delay) that lays every clip back onto the
 * real timeline (true gaps and all).
 */
export class ShoutCaster {
  private readonly cfg: OrchestratorConfig;
  private readonly eventBuffer: GameEventBuffer;
  private readonly centralState: CentralState;
  private readonly interpreter: BeatDetector;
  private readonly commentaryWriter: ICommentaryWriter;
  private readonly speechSynth: ISpeechSynthesizer;
  private readonly audioPlayer: AudioPlayer;
  private readonly recorder?: BroadcastRecorder;
  private readonly beatDebugRecorder?: BeatDebugRecorder;

  private readonly batcher: BeatBatcher;
  private readonly speechPool: Pool;
  /** Set once, from the very first beat ever produced — shared zero-point for
   *  `recorder` and `beatDebugRecorder` so their timelines stay aligned. */
  private sessionStartSeeded = false;

  // --- stage state ---
  /** Sealed batches awaiting the (sequential) text stage. */
  private sealedQueue: SealedBatch[] = [];
  /** True while an LLM call is in flight — enforces the sequential story dependency. */
  private textBusy = false;
  /** Rolling shoutcast history fed back to the LLM. */
  private passageHistory: Passage[] = [];
  /** Rendered clips (or FAILED markers) filed by batch index for the conductor. */
  private readonly rendered = new Map<number, RenderedSlot>();

  // --- conductor state ---
  private nextIndexToAir = 1;
  private conductorBusy = false;
  private lastRealizedDelayMs = 0;
  private lastGaugeAt = 0;

  // --- settling watermark ---
  /** Highest settled timestamp already interpreted. Everything ≤ this has been processed. */
  private lastWatermark = 0;
  /** Watermark of the last window that produced a real beat — drives the lull filler. */
  private lastRealBeatWatermark = 0;

  private running = false;
  private loop: ReturnType<typeof setInterval> | null = null;
  private interpretLoop: ReturnType<typeof setInterval> | null = null;

  constructor(
    cfg: OrchestratorConfig,
    eventBuffer: GameEventBuffer,
    centralState: CentralState,
    interpreter: BeatDetector,
    commentaryWriter: ICommentaryWriter,
    speechSynth: ISpeechSynthesizer,
    audioPlayer: AudioPlayer,
    recorder?: BroadcastRecorder,
    beatDebugRecorder?: BeatDebugRecorder
  ) {
    this.cfg = cfg;
    this.beatDebugRecorder = beatDebugRecorder;
    this.batcher = new BeatBatcher(cfg.beatGapMs, cfg.batchMaxMs, cfg.beatStoreCapacity, (beats) => {
      for (const b of beats) this.beatDebugRecorder?.recordBeat(b, "EVICTED-capacity");
    });
    this.speechPool = new Pool(cfg.speechConcurrency);
    this.eventBuffer = eventBuffer;
    this.centralState = centralState;
    this.interpreter = interpreter;
    this.commentaryWriter = commentaryWriter;
    this.speechSynth = speechSynth;
    this.audioPlayer = audioPlayer;
    this.recorder = recorder;
  }

  start(): void {
    this.running = true;
    void this.recorder?.start();
    this.beatDebugRecorder?.start();
    this.loop = setInterval(() => this.tick(), this.cfg.tickMs);
    this.interpretLoop = setInterval(() => this.interpretWindow(), this.cfg.interpretMs);
    log.info({ cfg: this.cfg }, "orchestrator started (delayed storyteller)");
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loop) clearInterval(this.loop);
    if (this.interpretLoop) clearInterval(this.interpretLoop);
    this.loop = null;
    this.interpretLoop = null;
    await this.recorder?.stop();
    await this.beatDebugRecorder?.stop();
    log.info("orchestrator stopped");
  }

  // --- Interpretation window -------------------------------------------------
  // Drain every raw event since the last window, reason over the batch + state
  // diff, and file the resulting beats onto the timeline. Sealing is handled by
  // the main tick so windows close on schedule even in silent windows.

  private interpretWindow(): void {
    const now = Date.now();
    const watermark = now - this.cfg.settleMs;
    // On the first run, start the window one interpret-tick wide ending at the watermark.
    if (this.lastWatermark === 0) {
      this.lastWatermark = watermark - this.cfg.interpretMs;
      this.lastRealBeatWatermark = watermark;
    }
    if (watermark <= this.lastWatermark) return; // nothing new has settled yet

    // Drain settled events regardless, so the buffer never backs up.
    const rawEvents = this.eventBuffer.flushOlderThan(watermark);
    const snapshots = this.centralState.getSnapshotsBetween(this.lastWatermark, watermark);

    const settledSnap = snapshots.length > 0 ? snapshots[snapshots.length - 1].snapshot : null;
    if (!settledSnap || settledSnap.players.length === 0) {
      this.lastWatermark = watermark; // warmup / nobody connected — just advance
      return;
    }

    const priorSnapshot = this.centralState.getSnapshotBefore(this.lastWatermark);
    const beats = this.interpreter.detect(rawEvents, snapshots, priorSnapshot);
    if (!this.sessionStartSeeded && beats.length > 0) {
      this.sessionStartSeeded = true;
      this.recorder?.seedSessionStart(beats[0].timestamp);
      this.beatDebugRecorder?.seedSessionStart(beats[0].timestamp);
    }
    for (const beat of beats) this.batcher.add(beat);

    // Only beats that will actually be spoken (medium/high) count as activity. Low-only
    // windows (ambient gunfire, lone deaths, economy reads) get dropped by the all-low
    // filter, so they must NOT keep the lull timer alive — otherwise a quiet-but-noisy
    // stretch produces no clips AND no filler, i.e. dead silence.
    const hasSpokenBeat = beats.some(b => b.intensity !== "low");
    if (hasSpokenBeat) {
      this.lastRealBeatWatermark = watermark;
    } else {
      this.maybeFillDeadAir(watermark, settledSnap);
    }

    this.lastWatermark = watermark;
  }

  /**
   * Inject a single synthetic "analysis" beat to fill genuine dead air. Fires only when
   * the broadcast has been silent for lullMs of settled time, the whole pipeline is idle
   * (so we never talk over real action), and the match is in live/freezetime. The beat is
   * anchored at the watermark so it airs at watermark + delayMs — exactly the moment now
   * showing on the delayed broadcast — and carries the tactical state for that moment.
   */
  private maybeFillDeadAir(watermark: number, snap: GameSnapshot): void {
    if (watermark - this.lastRealBeatWatermark < this.cfg.lullMs) return;
    if (snap.roundPhase !== "live" && snap.roundPhase !== "freezetime") return;

    // Only real upcoming audio should hold the filler off. Low-only batches sitting in
    // the batcher / sealedQueue are dropped before the text stage (all-low filter), so
    // they never become audio and must not block. textBusy / speech / rendered only ever
    // reflect medium/high (or filler) clips, which DO air — those gate us.
    const audioPending =
      this.textBusy ||
      this.speechPool.running > 0 ||
      this.speechPool.waiting > 0 ||
      this.rendered.size > 0;
    if (audioPending) return;

    this.batcher.add({
      id: -Date.now(), // negative id marks it synthetic
      type: "analysis",
      summary: "Lull in the action — set the scene and add expert analysis.",
      intensity: "low",
      timestamp: watermark,
    });
    this.lastRealBeatWatermark = watermark;
    log.debug({ at: formatClock(watermark) }, "💬 dead-air filler beat injected");
  }

  // --- Main tick -------------------------------------------------------------

  private tick(): void {
    const now = Date.now();
    // Seal clusters whose island is provably complete. The batcher runs on event time,
    // so it seals against the settled watermark (set by interpretWindow), not wall now.
    // Each batch is stamped with the snapshot AT ITS LAST BEAT (the moment it narrates),
    // not the live/future state — otherwise the caster spoils events that haven't aired.
    const sealed = this.batcher.collectSealed(
      this.lastWatermark,
      (ts) => this.centralState.getSnapshotAt(ts)
    );
    if (sealed.length > 0) this.sealedQueue.push(...sealed);

    this.maybeStartText();
    this.driveConductor();
    this.maybeLogGauge(now);
  }

  // --- Stage 1: Text (sequential, in game order) -----------------------------

  private maybeStartText(): void {
    if (this.textBusy || this.sealedQueue.length === 0) return;
    const batch = this.sealedQueue.shift()!;

    // Skip batches that carry only low-intensity ambient noise (gunfire, stray
    // deaths, economy reads during live play). A batch with no medium/high beat
    // is not worth an LLM + TTS call — it produces filler that pads the queue
    // and pushes real commentary further behind.
    const isFiller = batch.beats.some(b => b.type === "analysis");
    if (!isFiller && batch.beats.every(b => b.intensity === "low")) {
      const id = batchTrace(batch.index);
      log.debug({ batch: id, beats: batch.beats.length }, `${id} all-low batch — skipped`);
      for (const b of batch.beats) this.beatDebugRecorder?.recordBeat(b, "SKIPPED-all-low");
      this.markRendered(batch.index, "FAILED");
      return;
    }

    // No pipeline-depth gate: this is a fully delayed broadcast with no real-time
    // deadline, so the queue is free to grow as deep as it needs to. Every real
    // beat gets its commentary — the realized delay absorbs the backlog instead
    // of the broadcast dropping events to stay close to live.
    this.textBusy = true;
    void this.processText(batch);
  }

  private async processText(batch: SealedBatch): Promise<void> {
    const id = batchTrace(batch.index);
    const t0 = Date.now();
    for (const b of batch.beats) this.beatDebugRecorder?.recordBeat(b, "SENT");
    try {
      const result = await this.commentaryWriter.write({
        batchIndex: batch.index,
        beats: batch.beats,
        snapshot: batch.snapshot,
        passageHistory: this.passageHistory.slice(-this.cfg.passageHistoryCount),
        tacticalContext: this.interpreter.describeSituation(batch.snapshot),
      });
      if (!result) {
        log.warn({ batch: id }, `${id} produced no passage — skipping`);
        this.markRendered(batch.index, "FAILED");
        return;
      }

      const basedOn = batch.beats.map(e => e.summary);
      // Record the passage in history BEFORE the next batch starts (the finally
      // below releases textBusy), so the sequential story sees this line.
      this.passageHistory.push({ index: batch.index, text: result.transcript, anchorTs: batch.anchorTs, round: batch.snapshot.currentRound, basedOn });
      if (this.passageHistory.length > MAX_PASSAGE_HISTORY) {
        this.passageHistory.splice(0, this.passageHistory.length - MAX_PASSAGE_HISTORY);
      }

      const words = result.transcript.split(/\s+/).filter(Boolean).length;
      log.info(
        { batch: id, words, llmMs: Date.now() - t0, basedOn },
        `✍️  ${id} passage (${words}w, llm ${Date.now() - t0}ms) → "${result.transcript.slice(0, 120)}${result.transcript.length > 120 ? "…" : ""}"`
      );

      const planned: PlannedClip = {
        index: batch.index,
        anchorTs: batch.anchorTs,
        speech: result.speech,
        transcript: result.transcript,
        sourceBeatIds: batch.beats.map(e => e.id),
      };
      this.submitSpeech(planned);
    } catch (err) {
      log.error({ err, batch: id }, `${id} text stage error`);
      this.markRendered(batch.index, "FAILED");
    } finally {
      this.textBusy = false;
      // Keep the LLM flowing without waiting for the next tick.
      this.maybeStartText();
    }
  }

  // --- Stage 2: Speech (parallel pool) ---------------------------------------

  private submitSpeech(planned: PlannedClip): void {
    const id = batchTrace(planned.index);
    void this.speechPool
      .submit(async () => {
        const t0 = Date.now();
        const filePath = await this.speechSynth.synthesizeToFile(planned.speech);
        if (!filePath) {
          log.warn({ batch: id }, `${id} rendered no audio — skipping`);
          this.markRendered(planned.index, "FAILED");
          return;
        }
        const ttsMs = Date.now() - t0;
        const durationMs = Math.round(await wavDurationMs(filePath));
        const clip: RenderedClip = {
          index: planned.index,
          anchorTs: planned.anchorTs,
          filePath,
          sourceBeatIds: planned.sourceBeatIds,
          transcript: planned.transcript,
          durationMs,
          ttsMs,
        };
        log.info(
          { batch: id, durationMs, ttsMs },
          `🔊 ${id} rendered — ${durationMs}ms audio in ${ttsMs}ms tts`
        );
        this.markRendered(planned.index, clip);
      })
      .catch((err) => {
        log.error({ err, batch: id }, `${id} speech stage error`);
        this.markRendered(planned.index, "FAILED");
      });
  }

  private markRendered(index: number, slot: RenderedSlot): void {
    this.rendered.set(index, slot);
    this.driveConductor();
  }

  // --- Stage 3: Conductor (play head, delayMs behind real time) --------------
  // Airs clips strictly in batch-index order. Each clip waits until its real
  // moment (anchorTs + delayMs); a clip not yet rendered makes the head wait
  // (elastic delay); a clip whose target is already past plays immediately
  // (dense action back-to-back). A FAILED index is skipped.

  private driveConductor(): void {
    if (this.conductorBusy) return;
    const slot = this.rendered.get(this.nextIndexToAir);
    if (slot === undefined) return; // not ready yet — wait (elastic)

    this.rendered.delete(this.nextIndexToAir);
    const index = this.nextIndexToAir++;
    if (slot === "FAILED") {
      this.driveConductor(); // skip the gap, try the next index
      return;
    }
    this.conductorBusy = true;
    void this.airClip(slot);
  }

  private async airClip(clip: RenderedClip): Promise<void> {
    const id = batchTrace(clip.index);
    // Fixed delay, matching the OBS video feed delay configured to be generous enough
    // for the pipeline to keep up. No ratcheting, no expiry: cfg.delayMs is the contract,
    // and if a clip overruns it, that's a sign the configured delay needs to be larger —
    // not something this code should silently compensate for at runtime.
    const target = clip.anchorTs + this.cfg.delayMs;
    const waited = Math.max(0, target - Date.now());
    if (waited > 0) await sleep(waited);
    if (!this.running) { this.conductorBusy = false; return; }

    const airAt = Date.now();
    const realizedDelayMs = airAt - clip.anchorTs;
    this.lastRealizedDelayMs = realizedDelayMs;
    if (realizedDelayMs > this.cfg.delayMs) {
      log.warn(
        { batch: id, configuredDelayMs: this.cfg.delayMs, realizedDelayMs },
        `⚠️  ${id} overran the configured delay (${this.cfg.delayMs}ms) — realized ${realizedDelayMs}ms. Increase delayMs / the OBS feed delay.`
      );
    }
    log.info(
      {
        batch: id,
        anchor: formatClock(clip.anchorTs),
        realizedDelayMs,
        waitedMs: waited,
        durationMs: clip.durationMs,
      },
      `📡 ${id} AIRED — anchor ${formatClock(clip.anchorTs)}, realized delay ${(realizedDelayMs / 1000).toFixed(1)}s, waited ${waited}ms, len ${clip.durationMs}ms`
    );

    // Capture onto the broadcast timeline at the clip's GAME-time anchor, not the
    // real wall-clock moment it happened to finish rendering (airAt). The recording
    // is muxed against a separately delayed video feed at a fixed offset, so the
    // silence gaps between clips must track game-time spacing between events —
    // using airAt would bake in every pipeline stall/catch-up as permanent drift
    // against that video (reads the file now, before playback cleanup removes it).
    this.recorder?.record(clip.filePath, clip.anchorTs, clip.transcript);
    try {
      await this.audioPlayer.play(clip.filePath);
    } catch (err) {
      log.error({ err, batch: id }, `${id} playback error`);
    }
    await this.cleanupAudioFile(clip.filePath);

    this.conductorBusy = false;
    this.driveConductor();
  }

  // --- Backlog gauge ---------------------------------------------------------

  private maybeLogGauge(now: number): void {
    if (now - this.lastGaugeAt < 2000) return;
    this.lastGaugeAt = now;
    const sealedPending = this.sealedQueue.length + this.batcher.pendingCount();
    const renderedReady = this.rendered.size;
    if (sealedPending === 0 && renderedReady === 0 && !this.textBusy && this.speechPool.running === 0) {
      return; // idle — don't spam
    }
    log.debug(
      {
        sealed: sealedPending,
        textBusy: this.textBusy,
        speech: `${this.speechPool.running}+${this.speechPool.waiting}`,
        rendered: renderedReady,
        realizedDelayS: (this.lastRealizedDelayMs / 1000).toFixed(1),
      },
      `📊 backlog — sealed=${sealedPending} text=${this.textBusy ? 1 : 0} speech=${this.speechPool.running}+${this.speechPool.waiting} rendered=${renderedReady} delay=${(this.lastRealizedDelayMs / 1000).toFixed(1)}s`
    );
  }

  private async cleanupAudioFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch {
      // file already cleaned up
    }
  }
}
