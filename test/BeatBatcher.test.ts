import { describe, it, expect } from "vitest";
import { BeatBatcher } from "../src/orchestrator/BeatBatcher";
import type { Beat } from "../src/types/pipeline";
import type { GameSnapshot } from "../src/types/game";

const snap = { roundPhase: "live", players: [] } as unknown as GameSnapshot;
// collectSealed now takes a resolver (ts) => snapshot; tests don't vary state by time.
const resolve = (_ts: number) => snap;

function beat(id: number, type: string, timestamp: number): Beat {
  return { id, type, summary: `${type} ${id}`, intensity: "medium", timestamp };
}

// Constructor is (beatGapMs, batchMaxMs, capacity?). The batcher runs on EVENT TIME:
// gap and span are measured against beat timestamps, and collectSealed takes the
// settled watermark (sealClock) as its clock.
describe("BeatBatcher", () => {
  it("groups beats within the gap into one island and seals oldest-first", () => {
    const b = new BeatBatcher(1000, 10000);
    b.add(beat(1, "kill", 0));
    b.add(beat(2, "kill", 500));    // gap 500 ≤ 1000 → same island
    b.add(beat(3, "kill", 2000));   // gap 1500 > 1000 → new island opens

    // Island 1 (beats 1,2) is provably done once the watermark passes its last beat
    // (ts 500) by beatGapMs → at 1500. Island 2 is still open and not yet due.
    const first = b.collectSealed(1500, resolve);
    expect(first).toHaveLength(1);
    expect(first[0].index).toBe(1);
    expect(first[0].anchorTs).toBe(0);
    expect(first[0].beats.map(e => e.id)).toEqual([1, 2]);
    expect(first[0].forceSealed).toBe(false);

    // Island 2 seals once the watermark passes its last beat (2000) by the gap → 3000.
    expect(b.collectSealed(2999, resolve)).toHaveLength(0);
    const second = b.collectSealed(3000, resolve);
    expect(second).toHaveLength(1);
    expect(second[0].index).toBe(2);
    expect(second[0].beats.map(e => e.id)).toEqual([3]);
  });

  it("force-seals the current island early on a round boundary", () => {
    const b = new BeatBatcher(10000, 60000);
    b.add(beat(1, "kill", 0));
    b.add(beat(2, "roundEnd", 100)); // boundary → forceSeal even though the gap hasn't expired
    const sealed = b.collectSealed(100, resolve);
    expect(sealed).toHaveLength(1);
    expect(sealed[0].beats.map(e => e.type)).toEqual(["kill", "roundEnd"]);
    expect(sealed[0].forceSealed).toBe(true);
  });

  it("assembles an island that straddles multiple collect cycles into one batch", () => {
    // Simulates an ongoing firefight crossing several settle-window boundaries: each
    // collectSealed is a watermark advance. The island must stay open and keep absorbing
    // beats until beatGapMs of quiet, never sealing a half-island at a window cutoff.
    const b = new BeatBatcher(2000, 60000);
    b.add(beat(1, "kill", 0));
    expect(b.collectSealed(500, resolve)).toHaveLength(0);   // still open
    b.add(beat(2, "kill", 1000));                          // gap 1000 < 2000 → same island
    expect(b.collectSealed(1500, resolve)).toHaveLength(0);  // still open
    b.add(beat(3, "kill", 2500));                          // gap 1500 < 2000 → same island
    expect(b.collectSealed(3000, resolve)).toHaveLength(0);  // last beat 2500, needs 4500 to seal

    const sealed = b.collectSealed(4500, resolve);            // 4500 ≥ 2500 + 2000 → island done
    expect(sealed).toHaveLength(1);
    expect(sealed[0].anchorTs).toBe(0);                    // anchored to the FIRST beat
    expect(sealed[0].beats.map(e => e.id)).toEqual([1, 2, 3]);
  });

  it("creates separate islands across a long gap, with no empty batch between", () => {
    const b = new BeatBatcher(1000, 10000);
    b.add(beat(1, "kill", 0));      // island 1
    b.add(beat(2, "kill", 5000));   // gap 5000 > 1000 → island 2
    const sealed = b.collectSealed(6000, resolve);
    expect(sealed).toHaveLength(2);
    expect(sealed[0].anchorTs).toBe(0);
    expect(sealed[1].anchorTs).toBe(5000);
    expect(sealed.map(s => s.index)).toEqual([1, 2]); // contiguous indices
  });

  it("splits a long continuous firefight at batchMaxMs", () => {
    const b = new BeatBatcher(2000, 4000); // gap 2s, hard span cap 4s
    // Beats every 1s for 9s — all within the gap, so only the span cap can split them.
    for (let i = 0; i <= 9; i++) b.add(beat(i + 1, "kill", i * 1000));
    const sealed = b.collectSealed(100000, resolve);
    // Spans: [0..3000] (cap at 4000 → beat@4000 opens new), [4000..7000], [8000..9000].
    expect(sealed).toHaveLength(3);
    expect(sealed[0].anchorTs).toBe(0);
    expect(sealed[1].anchorTs).toBe(4000);
    expect(sealed[2].anchorTs).toBe(8000);
    // Every beat is accounted for exactly once.
    const allIds = sealed.flatMap(s => s.beats.map(e => e.id));
    expect(allIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("calls onEvicted with the oldest batch's beats when pending exceeds capacity", () => {
    const evicted: Beat[][] = [];
    const b = new BeatBatcher(0, 10000, 2, (beats) => evicted.push(beats));
    // gapMs=0 forces every beat into its own island (new batch each time), so three
    // adds push pending past capacity=2, evicting the first (oldest) island.
    b.add(beat(1, "kill", 0));
    b.add(beat(2, "kill", 1000));
    expect(evicted).toHaveLength(0);
    b.add(beat(3, "kill", 2000));
    expect(evicted).toHaveLength(1);
    expect(evicted[0].map(e => e.id)).toEqual([1]);
  });
});
