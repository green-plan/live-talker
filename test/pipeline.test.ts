import { describe, it, expect } from "vitest";
import { ShoutCaster } from "../src/orchestrator/ShoutCaster";
import { MockCommentaryWriter } from "../src/synthesis/MockCommentaryWriter";
import { DEFAULT_ORCHESTRATOR_CONFIG } from "../src/config";
import type {
  Beat,
  OrchestratorConfig,
  RenderedClip,
  SealedBatch,
} from "../src/types/pipeline";
import type { GameSnapshot } from "../src/types/game";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const snap = { roundPhase: "live", scoreCT: 0, scoreT: 0, currentRound: 1, players: [] } as unknown as GameSnapshot;

function beat(id: number): Beat {
  return { id, type: "kill", summary: `kill ${id}`, intensity: "medium", timestamp: Date.now() };
}

function sealedBatch(index: number, anchorTs: number, forceSealed = false): SealedBatch {
  return { index, beats: [beat(index)], anchorTs, snapshot: snap, forceSealed };
}

/** A sealed batch carrying only low-intensity ambient noise — dropped before the text stage. */
function lowOnlyBatch(index: number, anchorTs: number): SealedBatch {
  const b: Beat = { id: index, type: "gunfire", summary: "ambient", intensity: "low", timestamp: anchorTs };
  return { index, beats: [b], anchorTs, snapshot: snap, forceSealed: false };
}

/** A sealed batch carrying only the synthetic dead-air filler beat. */
function fillerBatch(index: number, anchorTs: number): SealedBatch {
  const b: Beat = { id: index, type: "analysis", summary: "filler", intensity: "low", timestamp: anchorTs };
  return { index, beats: [b], anchorTs, snapshot: snap, forceSealed: false };
}

/** A sealed batch with beats at explicit timestamps, for density tests. */
function multiBeatBatch(index: number, timestamps: number[]): SealedBatch {
  const beats: Beat[] = timestamps.map((ts, i) => ({
    id: index * 100 + i, type: "kill", summary: `kill ${i}`, intensity: "medium", timestamp: ts,
  }));
  return { index, beats, anchorTs: timestamps[0], snapshot: snap, forceSealed: false };
}

/** Fake player that records when each clip started and blocks for a set duration. */
class FakePlayer {
  isPlaying = false;
  readonly plays: { file: string; at: number }[] = [];
  constructor(private readonly durations: Record<string, number> = {}) {}
  async play(file: string): Promise<void> {
    this.isPlaying = true;
    this.plays.push({ file, at: Date.now() });
    await sleep(this.durations[file] ?? 10);
    this.isPlaying = false;
  }
}

function makeCaster(cfg: Partial<OrchestratorConfig>, player: any, textSynth: any) {
  const fakeCentral = { getSnapshot: () => snap } as any;
  const fakeInterpreter = { describeSituation: () => "" } as any;
  const noopSpeech = { synthesizeToFile: async () => null } as any;
  const sc = new ShoutCaster(
    { ...DEFAULT_ORCHESTRATOR_CONFIG, ...cfg },
    {} as any, // eventBuffer (unused here)
    fakeCentral,
    fakeInterpreter,
    textSynth,
    noopSpeech,
    player,
  );
  (sc as any).running = true; // start() would set this; tests drive stages directly
  return sc;
}

function rendered(index: number, anchorTs: number, durationMs: number): RenderedClip {
  return { index, anchorTs, filePath: `clip${index}`, sourceBeatIds: [index], transcript: `clip ${index}`, durationMs, ttsMs: 1 };
}

describe("Conductor (play head)", () => {
  it("airs in order, plays dense action back-to-back, and preserves real gaps", async () => {
    const player = new FakePlayer({ clip1: 250, clip2: 20, clip3: 20 });
    const sc: any = makeCaster({ delayMs: 200 }, player, new MockCommentaryWriter(0));
    const T0 = Date.now();

    sc.markRendered(1, rendered(1, T0, 250));
    sc.markRendered(2, rendered(2, T0 + 50, 20));   // anchor close to clip1
    sc.markRendered(3, rendered(3, T0 + 800, 20));  // big gap after clip2

    await sleep(1400);

    expect(player.plays.map(p => p.file)).toEqual(["clip1", "clip2", "clip3"]);
    const [p1, p2, p3] = player.plays;
    // clip1 airs ~T0+delay(200).
    expect(p1.at - T0).toBeGreaterThanOrEqual(180);
    // clip2 is back-to-back after clip1 (~250ms), NOT at its earlier target.
    expect(p2.at - p1.at).toBeGreaterThan(200);
    expect(p2.at - p1.at).toBeLessThan(400);
    // clip3's real gap (target T0+1000) is preserved — far more than its 20ms clip.
    expect(p3.at - p2.at).toBeGreaterThan(400);
  });

  it("waits (elastic) for a late clip rather than skipping it", async () => {
    const player = new FakePlayer();
    const sc: any = makeCaster({ delayMs: 50 }, player, new MockCommentaryWriter(0));
    const T0 = Date.now();

    sc.markRendered(1, rendered(1, T0, 10));
    await sleep(200);
    expect(player.plays.map(p => p.file)).toEqual(["clip1"]); // clip2 not yet rendered

    sc.markRendered(2, rendered(2, T0 + 20, 10)); // arrives late
    await sleep(200);
    expect(player.plays.map(p => p.file)).toEqual(["clip1", "clip2"]); // aired, in order
  });

  it("skips a FAILED batch without blocking the next", async () => {
    const player = new FakePlayer();
    const sc: any = makeCaster({ delayMs: 20 }, player, new MockCommentaryWriter(0));
    const T0 = Date.now();

    sc.markRendered(1, rendered(1, T0, 10));
    sc.markRendered(2, "FAILED");
    sc.markRendered(3, rendered(3, T0 + 20, 10));
    await sleep(250);
    expect(player.plays.map(p => p.file)).toEqual(["clip1", "clip3"]);
  });
});

describe("Dead-air filler (broadcast safety)", () => {
  // The lull filler must NEVER air over real action. It may only fire when the
  // pipeline holds no speakable commentary — even if that commentary is still
  // sitting in the sealed queue, not yet picked up by the text stage.
  const liveSnap = { roundPhase: "live", players: [{}] } as unknown as GameSnapshot;

  function idleCaster() {
    const sc: any = makeCaster({ lullMs: 1000 }, new FakePlayer(), new MockCommentaryWriter(0));
    sc.lastRealBeatWatermark = 0; // lull window has fully elapsed by watermark 10000
    return sc;
  }

  it("injects a filler when the pipeline is genuinely idle", () => {
    const sc = idleCaster();
    const before = sc.batcher.pendingCount();
    sc.maybeFillDeadAir(10000, liveSnap);
    expect(sc.batcher.pendingCount()).toBe(before + 1);
  });

  it("does NOT inject a filler while a speakable batch is still queued", () => {
    const sc = idleCaster();
    sc.sealedQueue = [sealedBatch(1, 0)]; // medium-intensity batch awaiting the text stage
    const before = sc.batcher.pendingCount();
    sc.maybeFillDeadAir(10000, liveSnap);
    expect(sc.batcher.pendingCount()).toBe(before); // held off — never talk over the real call
  });

  it("still injects a filler when the only queued batch is low-only (it never airs)", () => {
    const sc = idleCaster();
    sc.sealedQueue = [lowOnlyBatch(1, 0)]; // dropped before synthesis, so it must not block
    const before = sc.batcher.pendingCount();
    sc.maybeFillDeadAir(10000, liveSnap);
    expect(sc.batcher.pendingCount()).toBe(before + 1);
  });

  it("does NOT inject a filler while a clip is rendered and waiting to air", () => {
    const sc = idleCaster();
    sc.markRendered(1, rendered(1, 0, 10));
    const before = sc.batcher.pendingCount();
    sc.maybeFillDeadAir(10000, liveSnap);
    expect(sc.batcher.pendingCount()).toBe(before);
  });
});

describe("TextStage (sequential storyteller)", () => {
  it("runs batches in order, each seeing the prior passages, never overlapping", async () => {
    const player = new FakePlayer();
    // 60ms LLM delay — if the stage overlapped, history counts would race.
    const sc: any = makeCaster({}, player, new MockCommentaryWriter(60));
    const T0 = Date.now();

    sc.sealedQueue = [sealedBatch(1, T0), sealedBatch(2, T0 + 10), sealedBatch(3, T0 + 20)];
    sc.maybeStartText();
    await sleep(400);

    const texts = sc.passageHistory.map((p: any) => p.text);
    // MockCommentaryWriter echoes the passage-history length it was given.
    expect(texts).toEqual([
      expect.stringContaining("[MOCK#0]"),
      expect.stringContaining("[MOCK#1]"),
      expect.stringContaining("[MOCK#2]"),
    ]);
    expect(sc.passageHistory.map((p: any) => p.index)).toEqual([1, 2, 3]);
  });
});

describe("Settle wait (pressure-aware pickup)", () => {
  it("defers a batch with ample slack, capped at settleMaxMs", () => {
    const sc: any = makeCaster({ delayMs: 10000, settleReserveMs: 4000, settleMaxMs: 4000 }, new FakePlayer(), new MockCommentaryWriter(0));
    const now = Date.now();
    // deadline = anchorTs(now) + delay(10000) - reserve(4000) = now+6000, capped at now+settleMaxMs(4000).
    const readyAt = sc.computeSettleReadyAt(sealedBatch(1, now), now);
    expect(readyAt).toBe(now + 4000);
  });

  it("skips the wait entirely for a force-sealed (round/match boundary) batch", () => {
    const sc: any = makeCaster({ delayMs: 10000, settleReserveMs: 4000, settleMaxMs: 4000 }, new FakePlayer(), new MockCommentaryWriter(0));
    const now = Date.now();
    expect(sc.computeSettleReadyAt(sealedBatch(1, now, true), now)).toBe(now);
  });

  it("skips the wait entirely for the synthetic dead-air filler", () => {
    const sc: any = makeCaster({ delayMs: 10000, settleReserveMs: 4000, settleMaxMs: 4000 }, new FakePlayer(), new MockCommentaryWriter(0));
    const now = Date.now();
    expect(sc.computeSettleReadyAt(fillerBatch(1, now), now)).toBe(now);
  });

  it("does not wait when slack is already gone (deadline at or before now)", () => {
    const sc: any = makeCaster({ delayMs: 1000, settleReserveMs: 4000, settleMaxMs: 4000 }, new FakePlayer(), new MockCommentaryWriter(0));
    const now = Date.now();
    // deadline = anchorTs(now) + delay(1000) - reserve(4000) = now-3000, already past.
    expect(sc.computeSettleReadyAt(sealedBatch(1, now), now)).toBe(now);
  });

  it("holds a settling batch's text-stage pickup until its readyAt passes", async () => {
    const sc: any = makeCaster({}, new FakePlayer(), new MockCommentaryWriter(0));
    const T0 = Date.now();
    const batch = sealedBatch(1, T0);
    sc.sealedQueue = [batch];
    sc.settleDeadlines.set(1, T0 + 200); // still settling

    sc.maybeStartText();
    await sleep(20);
    expect(sc.passageHistory).toHaveLength(0); // gated — not picked up yet

    sc.settleDeadlines.set(1, T0); // settle window over
    sc.maybeStartText();
    await sleep(50);
    expect(sc.passageHistory).toHaveLength(1); // now processed
  });

  it("never gates an all-low batch on the settle wait", async () => {
    const sc: any = makeCaster({}, new FakePlayer(), new MockCommentaryWriter(0));
    const T0 = Date.now();
    sc.sealedQueue = [lowOnlyBatch(1, T0)];
    sc.settleDeadlines.set(1, T0 + 60000); // would never become ready in this test's lifetime

    sc.maybeStartText();
    // Skipped immediately despite the far-future settle deadline: shifted off the
    // queue and consumed by the conductor's FAILED-skip in the same synchronous call.
    expect(sc.sealedQueue).toHaveLength(0);
    expect(sc.nextIndexToAir).toBe(2);
  });
});

describe("Backlog depth (does NOT count batches still settling)", () => {
  it("does not count a batch that merely sealed during another batch's settle wait", () => {
    const sc: any = makeCaster({}, new FakePlayer(), new MockCommentaryWriter(0));
    const T0 = Date.now();
    sc.sealedQueue = [sealedBatch(2, T0)];
    sc.settleDeadlines.set(2, T0 + 60000); // still settling — not actual backlog
    expect(sc.backlogDepth()).toBe(0);
  });

  it("counts a batch whose own settle wait has already elapsed", () => {
    const sc: any = makeCaster({}, new FakePlayer(), new MockCommentaryWriter(0));
    const T0 = Date.now();
    sc.sealedQueue = [sealedBatch(2, T0)];
    sc.settleDeadlines.set(2, T0 - 1); // already past its own readyAt — genuinely waiting
    expect(sc.backlogDepth()).toBe(1);
  });
});

describe("Delivery planning (pace/density)", () => {
  it("calls the same beat count denser when packed into a smaller real-time span (4+ beats — 2-beat batches never reach 'busy' on density alone)", () => {
    const sc: any = makeCaster({}, new FakePlayer(), new MockCommentaryWriter(0));
    const T0 = Date.now();
    const tight = sc.planDelivery(multiBeatBatch(1, [T0, T0 + 1000, T0 + 2000, T0 + 3000]), 0);   // 4 beats / 3s
    const loose = sc.planDelivery(multiBeatBatch(2, [T0, T0 + 4000, T0 + 8000, T0 + 12000]), 0);  // 4 beats / 12s
    expect(tight.targetWords).toBeLessThanOrEqual(loose.targetWords);
    expect(tight.pace).toBe("busy"); // density alone never reaches "urgent" — see Pace/density model comment
    expect(loose.pace).toBe("normal");
  });

  it("never reaches 'busy' or 'urgent' from density alone for a routine 2-beat batch (e.g. a double-kill call-out), no matter how tight", () => {
    const sc: any = makeCaster({}, new FakePlayer(), new MockCommentaryWriter(0));
    const T0 = Date.now();
    const { pace } = sc.planDelivery(multiBeatBatch(1, [T0, T0 + 500]), 0); // 2 beats, very tight, no backlog
    expect(pace).toBe("normal");
  });

  it("does not force urgency on a lone beat just because it has no span of its own", () => {
    const sc: any = makeCaster({}, new FakePlayer(), new MockCommentaryWriter(0));
    const T0 = Date.now();
    const { pace } = sc.planDelivery(sealedBatch(1, T0), 0); // 1 beat, queueDepth 0
    expect(pace).toBe("normal");
  });

  it("escalates pace from backlog (queueDepth) even with zero density", () => {
    const sc: any = makeCaster({}, new FakePlayer(), new MockCommentaryWriter(0));
    const T0 = Date.now();
    const { pace } = sc.planDelivery(sealedBatch(1, T0), 5); // 1 beat, heavy backlog
    expect(pace).toBe("urgent");
  });

  it("never reaches 'urgent' from density alone, even for a tightly-clustered 5-beat batch with no backlog", () => {
    const sc: any = makeCaster({}, new FakePlayer(), new MockCommentaryWriter(0));
    const T0 = Date.now();
    const { pace } = sc.planDelivery(multiBeatBatch(1, [T0, T0, T0, T0, T0]), 0); // 5 simultaneous beats, no backlog
    expect(pace).toBe("busy"); // dense, but "urgent" requires real backlog
  });

  it("always plans a calm, fuller-budget read for the dead-air filler", () => {
    const sc: any = makeCaster({}, new FakePlayer(), new MockCommentaryWriter(0));
    const T0 = Date.now();
    const { pace, targetWords } = sc.planDelivery(fillerBatch(1, T0), 10); // heavy backlog, irrelevant
    expect(pace).toBe("normal");
    expect(targetWords).toBe(30);
  });

  it("does not max out density just because two beats share a timestamp (e.g. a kill + its multiKill call-out)", () => {
    const sc: any = makeCaster({}, new FakePlayer(), new MockCommentaryWriter(0));
    const T0 = Date.now();
    const { pace } = sc.planDelivery(multiBeatBatch(1, [T0, T0]), 0); // zero span, no backlog
    expect(pace).not.toBe("urgent"); // floored span, not infinite density
  });

  it("stays normal for a 2-beat batch spread across the full batchMaxMs window", () => {
    const sc: any = makeCaster({ batchMaxMs: 5000 }, new FakePlayer(), new MockCommentaryWriter(0));
    const T0 = Date.now();
    const { pace } = sc.planDelivery(multiBeatBatch(1, [T0, T0 + 5000]), 0); // loosest possible 2-beat span
    expect(pace).toBe("normal");
  });
});
