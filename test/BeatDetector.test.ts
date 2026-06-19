import { describe, it, expect } from "vitest";
import { BeatDetector } from "../src/game/cs2/BeatDetector";
import type { GameSnapshot, PlayerSnapshot, TimedSnapshot, GsiEvent } from "../src/types/game";

// High-level coverage of the CS2 "Analyst": raw GSI events + snapshot diffs → beats,
// plus the plain-English tactical read. Uses small hand-built snapshots rather than the
// full csgogsi shape — BeatDetector only ever sees the normalized GameSnapshot.

function player(p: Partial<PlayerSnapshot> & { name: string; team: "CT" | "T" }): PlayerSnapshot {
  return {
    steamid: p.steamid ?? `id-${p.name}`,
    name: p.name,
    team: p.team,
    alive: p.alive ?? true,
    health: p.health ?? 100,
    armor: p.armor ?? 100,
    money: p.money ?? 3000,
    equipValue: p.equipValue ?? 4000,
    killsThisRound: p.killsThisRound ?? 0,
    currentWeapon: p.currentWeapon ?? "ak47",
    ammoClip: p.ammoClip ?? 30,
    reloading: p.reloading ?? false,
    flashed: p.flashed ?? 0,
    burning: p.burning ?? 0,
    hasBomb: p.hasBomb ?? false,
    hasDefuseKit: p.hasDefuseKit ?? false,
    location: p.location ?? null,
  };
}

function snapshot(over: Partial<GameSnapshot> & { players: PlayerSnapshot[] }): GameSnapshot {
  const players = over.players;
  return {
    currentMap: over.currentMap ?? "de_mirage",
    roundPhase: over.roundPhase ?? "live",
    scoreCT: over.scoreCT ?? 0,
    scoreT: over.scoreT ?? 0,
    currentRound: over.currentRound ?? 5,
    bombState: over.bombState ?? "carried",
    bombCountdown: over.bombCountdown ?? null,
    bombSite: over.bombSite ?? null,
    aliveCT: over.aliveCT ?? players.filter(p => p.team === "CT" && p.alive).length,
    aliveT: over.aliveT ?? players.filter(p => p.team === "T" && p.alive).length,
    players,
  };
}

const timed = (snapshot: GameSnapshot, ts = Date.now()): TimedSnapshot => ({ ts, snapshot });

describe("BeatDetector", () => {
  it("derives an entry-frag beat from a kill state-diff", () => {
    const det = new BeatDetector();
    const before = snapshot({ players: [player({ name: "Vex", team: "CT" }), player({ name: "Knox", team: "T" })] });
    const after = snapshot({
      players: [
        player({ name: "Vex", team: "CT", killsThisRound: 1 }),
        player({ name: "Knox", team: "T", alive: false, health: 0 }),
      ],
    });

    const beats = det.detect([], [timed(after)], before);

    const kill = beats.find(b => b.type === "entryKill");
    expect(kill, "expected an entryKill beat from the diff").toBeDefined();
    expect(kill!.players).toContain("Vex");
    expect(kill!.summary).toContain("Knox");
  });

  it("flags a 1vN clutch during live play", () => {
    const det = new BeatDetector();
    const snap = snapshot({
      players: [
        player({ name: "Vex", team: "CT", alive: true }),
        player({ name: "Knox", team: "T", alive: true }),
        player({ name: "Sable", team: "T", alive: true }),
      ],
      roundPhase: "live",
    });

    const beats = det.detect([], [timed(snap)], snap);

    const clutch = beats.find(b => b.type === "clutch");
    expect(clutch, "expected a clutch beat for 1 CT vs 2 T").toBeDefined();
    expect(clutch!.summary).toContain("1v2");
    expect(clutch!.players).toContain("Vex");
  });

  it("passes a bomb-plant objective event straight through as a high-intensity beat", () => {
    const det = new BeatDetector();
    const evt: GsiEvent = { id: 1, event: "bombPlant", playerName: "Knox", data: null, timestamp: Date.now() };

    const beats = det.detect([evt], [], null);

    const plant = beats.find(b => b.type === "bombPlant");
    expect(plant, "expected a bombPlant beat").toBeDefined();
    expect(plant!.summary).toContain("Knox");
    expect(plant!.intensity).toBe("high");
  });

  it("describes a ticking post-plant situation in plain English", () => {
    const det = new BeatDetector();
    const snap = snapshot({
      players: [player({ name: "Vex", team: "CT" }), player({ name: "Knox", team: "T" })],
      bombState: "planted",
      bombCountdown: 30,
      bombSite: "A",
      roundPhase: "live",
      scoreCT: 3,
      scoreT: 2,
      aliveCT: 1,
      aliveT: 1,
    });

    const text = det.describeSituation(snap);

    expect(text).toContain("BOMB PLANTED on A");
    expect(text).toContain("Round 5");
  });
});
