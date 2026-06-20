import type { Beat, SealedBatch } from "../types/pipeline.js";
import type { GameSnapshot } from "../types/game.js";
import { logger } from "../utils/logger.js";
import { batchTrace, formatClock } from "../utils/time.js";

const log = logger.child({ service: "[BeatBatcher]" });

// Beat types that close the current batch immediately, so each story segment
// ends on a clean game boundary (a round/match never bleeds into the next).
const BOUNDARY_TYPES: ReadonlySet<string> = new Set(["roundEnd", "matchEnd"]);

/** A beat cluster still accumulating — pre-seal, mutable. */
interface OpenBatch {
  beats: Beat[];
  /** Event timestamp of the first beat — becomes anchorTs and windowStart. */
  windowStart: number;
  /** Event timestamp of the most recent beat — the idle-gap reference. */
  lastBeatTs: number;
  /** Set when a round/match-boundary beat lands — forces an early seal on next collect. */
  forceSeal: boolean;
}

/**
 * BeatBatcher — "The Timeline".
 *
 * Groups interpreted beats into density-based clusters ("islands of beats")
 * rather than fixed time windows. A cluster seals when:
 *   1. No new beat arrives for `beatGapMs` (idle gap — the island ended naturally).
 *   2. The event-time span of the cluster reaches `batchMaxMs` (safety cap).
 *   3. A round/match-boundary beat lands (forceSeal — clean narrative cut).
 *
 * This means a rapid 5-kill ACE produces one batch covering ~3s, while a slow
 * round with kills spread across 20s produces several small, well-timed clips —
 * rather than one huge window or many fixed-width clips that misalign with action.
 *
 * The batch `anchorTs` = first beat's event timestamp (the real game-time moment
 * the action began). The Conductor uses `anchorTs + delayMs` as the air time, so
 * clips are pinned to when the action actually happened, not when the interpreter ran.
 *
 * Everything here runs on the EVENT-TIME clock: gap and span are measured against
 * beat timestamps, and `collectSealed` takes the settled watermark as its clock. A
 * cluster is provably complete once the watermark has passed its last beat by
 * beatGapMs, because no event newer than the watermark can still arrive.
 *
 * The monotonic batch `index` is the correlative trace id ("b0042") carried through
 * the rest of the pipeline.
 */
export class BeatBatcher {
  private readonly beatGapMs: number;
  private readonly batchMaxMs: number;
  private readonly capacity: number;

  private pending: OpenBatch[] = [];
  private openBatch: OpenBatch | null = null;
  private nextIndex = 1;
  private readonly onEvicted?: (beats: Beat[]) => void;

  constructor(beatGapMs: number, batchMaxMs: number, capacity = 1000, onEvicted?: (beats: Beat[]) => void) {
    this.beatGapMs = beatGapMs;
    this.batchMaxMs = batchMaxMs;
    this.capacity = capacity;
    this.onEvicted = onEvicted;
  }

  /**
   * File a beat into the current cluster. Opens a new cluster when:
   * - No cluster is open.
   * - The current cluster is already force-sealed (boundary beat landed).
   * - Adding this beat would push the cluster's event-time span past batchMaxMs.
   */
  add(beat: Beat): void {
    let open = this.openBatch;

    const spanExceeded = open && !open.forceSeal &&
      (beat.timestamp - open.windowStart) >= this.batchMaxMs;
    // A beat at least beatGapMs past the open cluster's last beat belongs to a new
    // island (the previous one ended). Uses >= to match collectSealed, which treats
    // an island as sealable the instant the clock reaches lastBeatTs + beatGapMs —
    // so a beat landing exactly on that frontier opens the next island, not this one.
    const gapExceeded = open && !open.forceSeal &&
      (beat.timestamp - open.lastBeatTs) >= this.beatGapMs;

    const needsNew = !open || open.forceSeal || spanExceeded || gapExceeded;
    if (needsNew) {
      open = {
        beats: [],
        windowStart: beat.timestamp,
        lastBeatTs: beat.timestamp,
        forceSeal: false,
      };
      this.pending.push(open);
      this.openBatch = open;
      // Safety valve: if downstream stalled so hard that pending blew past the
      // cap, drop the very oldest (it would be ancient history anyway).
      while (this.pending.length > this.capacity) {
        const evicted = this.pending.shift()!;
        this.onEvicted?.(evicted.beats);
      }
    }

    open!.beats.push(beat);
    open!.lastBeatTs = beat.timestamp;  // advance the idle-gap reference
    if (BOUNDARY_TYPES.has(beat.type)) open!.forceSeal = true;
  }

  /**
   * Seal and return every cluster that is ready, oldest-first. `sealClock` is the settled
   * watermark — the frontier of fully-known event time. `resolveSnapshot(ts)` returns the
   * match state AS OF that event time: each batch is stamped with the snapshot at its last
   * beat (windowEnd), i.e. the moment it narrates — NOT the live/future state at seal time.
   * Using the future state let the caster spoil or double-call events that hadn't aired yet
   * (e.g. a lull-filler describing a bomb explosion that the real beat then called again).
   * Stops at the first not-yet-ready cluster so emission order stays monotonic.
   *
   * A cluster is ready when:
   * - It is no longer the open cluster (a newer one started), OR
   * - It was force-sealed by a boundary beat, OR
   * - The watermark has passed its last beat by beatGapMs (the island is provably done).
   */
  collectSealed(sealClock: number, resolveSnapshot: (ts: number) => GameSnapshot): SealedBatch[] {
    const out: SealedBatch[] = [];
    while (this.pending.length > 0) {
      const b = this.pending[0];
      const isOpen = b === this.openBatch;
      const gapExpired = sealClock >= b.lastBeatTs + this.beatGapMs;
      const ready = b.forceSeal || !isOpen || gapExpired;
      if (!ready) break;

      this.pending.shift();
      if (isOpen) this.openBatch = null;

      const lastTs = b.beats[b.beats.length - 1]?.timestamp ?? b.windowStart;
      const sealed: SealedBatch = {
        index: this.nextIndex++,
        beats: b.beats,
        anchorTs: b.windowStart,
        snapshot: resolveSnapshot(lastTs),
        forceSealed: b.forceSeal,
      };
      out.push(sealed);

      const kills = b.beats.filter(e => e.type.includes("kill") || e.type.includes("Kill")).length;
      const spanMs = lastTs - b.windowStart;
      log.info(
        { batch: batchTrace(sealed.index), beats: b.beats.length, kills, spanMs, forced: b.forceSeal },
        `📦 ${batchTrace(sealed.index)} sealed — ${b.beats.length} beats (${kills} kills), span ${(spanMs / 1000).toFixed(1)}s ${formatClock(b.windowStart)}–${formatClock(lastTs)}`
      );
    }
    return out;
  }

  /** Number of clusters still waiting to seal — for the backlog gauge. */
  pendingCount(): number {
    return this.pending.length;
  }
}
