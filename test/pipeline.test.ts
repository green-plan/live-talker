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

function sealedBatch(index: number, anchorTs: number): SealedBatch {
  return { index, beats: [beat(index)], anchorTs, snapshot: snap };
}

/** A sealed batch carrying only low-intensity ambient noise — dropped before the text stage. */
function lowOnlyBatch(index: number, anchorTs: number): SealedBatch {
  const b: Beat = { id: index, type: "gunfire", summary: "ambient", intensity: "low", timestamp: anchorTs };
  return { index, beats: [b], anchorTs, snapshot: snap };
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
