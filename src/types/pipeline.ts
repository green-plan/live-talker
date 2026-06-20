import type { GameSnapshot } from "./game.js";

export type EventIntensity = 'low' | 'medium' | 'high';

/**
 * A meaningful, deduped narrative beat produced by BeatDetector from a window
 * of raw events + state diffs. This is what feeds the LLM.
 *
 * `timestamp` is the real wall-clock moment the action happened — it anchors the
 * beat onto the broadcast timeline (the batch's earliest beat sets its air time).
 *
 * Known types: kill, entryKill, tradeKill, multiKill, death, gunfire (aggregated
 *   ambient firing), gotFlashed, onFire, lowHP, bombPlant, bombDefuse, bombExplode,
 *   defuseStart, roundEnd, matchEnd, mvp, clutch, economy, analysis (synthetic
 *   downtime/filler beat injected during a lull — no discrete game event behind it).
 */
export interface Beat {
  id: number;
  /** Semantic category — used by the LLM prompt and batching/boundary logic. */
  type: string;
  /** Human-readable one-liner for the LLM, e.g. "Vex draws first blood on Sable". */
  summary: string;
  intensity: EventIntensity;
  players?: string[];
  /** Map callout where the beat happened (e.g. "BodyShop"), when a position is known. */
  location?: string;
  /**
   * Ground-truth alive counts immediately AFTER this beat (combat beats only).
   * Lets the LLM quote an exact count tied to a specific event instead of having
   * to infer/recompute it from a single batch-level snapshot — see CommentaryWriter's
   * `→ NvM` event-line annotation.
   */
  aliveCT?: number;
  aliveT?: number;
  data?: unknown;
  timestamp: number;
}

// --- Delayed-broadcast timeline model ---------------------------------------
// The pipeline runs on a deliberate delay: beats accumulate into time-windowed
// batches, each batch becomes one storyteller passage → one clip, and the
// Conductor lays those clips back onto the real timeline. Every artifact carries
// the batch `index` as a correlative trace id (rendered as "b0042" in logs).

/**
 * Lifecycle of a batch as it moves through the delayed pipeline. Reserved for the
 * planned commentary state machine — not yet tracked as a field on SealedBatch
 * (the live pipeline derives stage from textBusy / the rendered map / the conductor).
 */
export type BatchState =
  | 'ACCUMULATING' // open window, still collecting beats
  | 'SEALED'       // window closed; handed to the text stage
  | 'TEXT_DONE'    // passage written; queued for speech
  | 'RENDERED'     // audio rendered; queued for the conductor
  | 'AIRED'        // played out (terminal, success)
  | 'FAILED';      // synthesis produced nothing (terminal, skipped by the conductor)

/**
 * A window of beats sealed for narration. `index` is the monotonic trace id used
 * across the whole pipeline. `anchorTs` (earliest beat timestamp) is when the
 * action began — the clip airs at `anchorTs + delayMs`. `snapshot` is captured at
 * seal time so the LLM reads the match state as of that moment, not when it runs.
 */
export interface SealedBatch {
  index: number;
  beats: Beat[];
  anchorTs: number;
  snapshot: GameSnapshot;
  /** True when this batch was sealed early by a round/match-boundary beat rather
   *  than an idle gap or the span cap — already a clean narrative cut, so the
   *  orchestrator's pressure-settle wait (see OrchestratorConfig.settleMaxMs)
   *  skips it and picks it up immediately. */
  forceSealed: boolean;
}

/**
 * Identity carried by a passage as it moves through the speech + conductor
 * stages: which batch it is, when its action happened, the spoken words, and
 * the beats it covered. PlannedClip and RenderedClip both build on this so the
 * shared fields are declared (and evolve) in exactly one place.
 */
export interface ClipBase {
  /** Batch index — correlates the passage across every stage. */
  index: number;
  /** When the action this passage covers began (batch anchorTs). (ms) */
  anchorTs: number;
  /** Spoken words only — recorded in the passage history and subtitle track. */
  transcript: string;
  /** The beat ids this passage covered. */
  sourceBeatIds: number[];
}

/** A storyteller passage produced from a batch, ready for speech synthesis. */
export interface PlannedClip extends ClipBase {
  /** Full text handed to TTS (may carry voice-engine scaffolding). */
  speech: string;
}

/** A rendered audio clip waiting for the conductor to air it. */
export interface RenderedClip extends ClipBase {
  filePath: string;
  /** Actual audio length of the clip. (ms) */
  durationMs: number;
  /** How long the TTS render took. (ms) */
  ttsMs: number;
}

/**
 * A passage the caster has committed to speaking. Kept as a rolling "shoutcast
 * history" and fed back to the LLM so each new passage continues the story
 * naturally and never repeats a call already made.
 */
export interface Passage {
  /** Batch index this passage came from. */
  index: number;
  /** The spoken passage (transcript form — no TTS scaffolding). */
  text: string;
  /** When the action this passage covers began (batch anchorTs). (ms) */
  anchorTs: number;
  /** Round number when this passage was spoken — helps the LLM understand cross-round age. */
  round: number;
  /** Summaries of the beats this passage was based on — the "why" behind the call. */
  basedOn: string[];
  /** The exact user-turn content sent for this passage — replayed verbatim as a
   *  historical `user` message so future calls continue the real conversation
   *  instead of reading a text summary of it. */
  userTurn: string;
}

/**
 * Timing and structural parameters for the ShoutCaster orchestrator.
 *
 * Pipeline overview (delayed storyteller):
 *   GsiListener (raw events + state)
 *     → [every tick] BeatDetector → beats
 *     → BeatBatcher (time-windowed) → SealedBatch
 *     → TextStage (sequential, in game order) → PlannedClip
 *     → SpeechStage (parallel pool) → RenderedClip
 *     → Conductor (play head, `delayMs` behind real time) → IAudioSink / Recorder
 */
export interface OrchestratorConfig {
  /** How often the housekeeping tick runs — drives sealing, the conductor poll,
   *  and beat detection (interpretWindow runs every tick). (ms) */
  tickMs: number;
  /**
   * Silence (event time) before a synthetic "analysis" filler beat is injected to fill
   * dead air. Only fires in live/freezetime, with players connected, when the whole
   * pipeline is idle — so it never talks over real action. (ms)
   */
  lullMs: number;
  /**
   * Idle gap that seals the current beat cluster. A batch closes when no new beat
   * arrives within this window after the last one — "island of beats" detection.
   */
  beatGapMs: number;
  /**
   * Hard upper limit on a single batch's event-time span (last beat ts − first beat ts).
   * Prevents a single very long firefight from producing a 30s monologue.
   * Independent from beatGapMs — whichever triggers first wins. (ms)
   */
  batchMaxMs: number;
  /** Fixed broadcast delay. The play head always airs a clip at anchorTs + this;
   *  if generation falls behind, the clip airs late and a warning is logged, but
   *  the delay itself never adjusts — match the OBS feed delay to this value. (ms) */
  delayMs: number;
  /**
   * Time reserved for the LLM + TTS + conductor handoff that still has to happen
   * after a batch's pressure-settle wait ends (see settleMaxMs). Subtracted from
   * the batch's hard air deadline (anchorTs + delayMs) when computing how much
   * slack is available to wait in — so the wait never eats into time the
   * downstream stages actually need to land the clip on time. (ms)
   */
  settleReserveMs: number;
  /**
   * Hard cap on how long the text stage will defer picking up a freshly sealed
   * batch in order to get a fuller read on incoming pressure (queueDepth sampled
   * later, once more beats have had a chance to seal behind it) before sizing the
   * clip. Bounded by the deadline's actual slack regardless — this just stops a
   * genuine lull with abundant slack from stalling pickup pointlessly. (ms)
   */
  settleMaxMs: number;
  /** LLM stage parallelism. Retained for symmetry, but the story dependency
   *  (each call needs the previous passage) makes it effectively 1. */
  textConcurrency: number;
  /** TTS pool depth — renders many clips in parallel behind the ordered LLM. */
  speechConcurrency: number;
  /** How many recent passages are fed to the LLM as its shoutcast history. */
  passageHistoryCount: number;
  /** Ring-buffer cap on retained batches — adding past this evicts the oldest aired. */
  beatStoreCapacity: number;
}
