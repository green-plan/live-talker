import type {
  GsiEvent,
  PlayerSnapshot,
  GameSnapshot,
  TimedSnapshot,
} from "../../types/game.js";
import type { Beat, EventIntensity } from "../../types/pipeline.js";
import { logger } from "../../utils/logger.js";

const log = logger.child({ service: "[BeatDetector]" });

// --- Tuning knobs -----------------------------------------------------------
// HP at/below which a "clinging on" warning is emitted. Lowering this makes
// the low-HP signal more selective; raising it creates more noise on spray duels.
const LOW_HP            = 25;

// csgogsi flashed range is 0–255. Values below ~100 are partial flashes that
// don't fully blind — not worth narrating. 100 is the practical "effectively
// blind" threshold used in gameplay readouts.
const FLASH_THRESHOLD   = 100;

// Per-(player, signal) minimum gap before the same continuous-state edge can
// be re-emitted. Prevents "Vex is firing" repeating every 1.5s throughout
// a long spray. 4s covers roughly 3 interpreter windows.
const COOLDOWN_MS       = 4000;

// A kill is a trade if a same-side teammate died within this window. 5s is
// standard in pro CS2 analysis — long enough to credit reactive plays without
// marking unrelated kills as trades.
const TRADE_WINDOW_MS   = 5000;

// Kills within this window of each other count toward a multi-kill streak.
// 4.5s is generous enough to cover rapid frags via the 2s interpret cadence.
const MULTIKILL_WINDOW_MS = 4500;

// Per-player "X is firing" is noise that floods the commentary. Instead we emit
// at most one ambient "gunfire" beat this often, when anyone is shooting.
const FIRING_AGGREGATE_MS = 6000;

const MULTIKILL_TERMS: Record<number, string> = {
  2: "double kill",
  3: "TRIPLE KILL",
  4: "QUAD KILL",
  5: "ACE",
};

interface DeathRecord { side: "CT" | "T"; at: number; }

/**
 * BeatDetector — "The Analyst".
 *
 * Pure business logic, invoked by the ShoutCaster on a fixed window (~2s).
 * Each call reasons over the whole batch of raw events that built up since the
 * last detection run, PLUS a state diff against the previous window, and emits
 * a deduped stream of meaningful narrative beats for the LLM. It owns its own
 * memory; it never touches the raw GameEventBuffer or the ingestion path.
 *
 * Combat (kills/deaths/firing/flash) is derived from STATE deltas, not from
 * csgogsi kill/hurt events — those only fire via digestMIRV (HLAE), never via
 * the plain HTTP digest() path that standard CS2 GSI uses. See README-GAMEPLAY.
 */
export class BeatDetector {
  private serial = 0;
  /** `"${steamid}:${signal}" → last-emit timestamp` — gates repeated continuous-state edges. */
  private cooldowns = new Map<string, number>();
  /** Deaths recorded this round with side + timestamp — used to detect trade kills. */
  private deaths: DeathRecord[] = [];
  /**
   * Per-player rapid-kill streak state.
   * `base` = round_kills value when the current streak started (kills before
   *   this streak don't count). `lastAt` = wall-clock time of the last kill in
   *   the streak. `announced` = highest streak depth already announced.
   * Resets on a new round. The streak itself resets whenever a kill arrives
   * more than MULTIKILL_WINDOW_MS after the previous one.
   */
  private multiKillStreaks = new Map<string, { base: number; lastAt: number; announced: number }>();
  /** Round number when the economy beat was last emitted — prevents duplicate buy-phase reads. */
  private currentRound = -1;
  private economyRound = -1;
  /** Round number when the clutch beat was last emitted — one announcement per round. */
  private clutchRound = -1;
  /** Last time an aggregated "gunfire" ambient beat was emitted. */
  private lastFiringBeat = 0;

  /**
   * Detect beats in a settled window. `snapshots` is the chronological list of GSI
   * snapshots observed in the window; we WALK consecutive pairs so each derived beat
   * is stamped with the exact moment (`cur.ts`) it first appeared — accurate to GSI
   * packet cadence rather than the coarse detect tick. Objective events carry their
   * own receive timestamp and are processed once over the window.
   */
  detect(rawEvents: GsiEvent[], snapshots: TimedSnapshot[], priorSnapshot: GameSnapshot | null = null): Beat[] {
    const out: Beat[] = [];

    // Objective/flow events (bomb, round, mvp) keep their own receive timestamps.
    this.processObjectiveEvents(rawEvents, out);

    // Walk every snapshot in the window in order, diffing each against the previous one.
    // priorSnapshot is the last snapshot from the previous window (supplied by the caller
    // from CentralState's ring) so the first entry in this window has something to diff against.
    let prev: GameSnapshot | null = priorSnapshot;
    for (const { ts, snapshot } of snapshots) {
      // Reset round-scoped trackers on a new round (may happen mid-window).
      if (snapshot.currentRound !== this.currentRound) {
        this.currentRound = snapshot.currentRound;
        this.deaths = [];
        this.multiKillStreaks.clear();
      }

      if (prev) {
        this.processCombat(prev, snapshot, ts, out);
        this.processCompound(prev, snapshot, ts, out);
      }
      prev = snapshot;
    }

    if (out.length > 0) {
      log.debug(
        { count: out.length, beats: out.map(e => `${e.type}:${e.summary}`) },
        `🧠 detected (${rawEvents.length} raw, ${snapshots.length} snaps) → ${out.length} beats`
      );
    }
    return out;
  }

  // --- 1. Objective / flow events from the raw buffer ------------------------
  // These DO fire via digest(): bomb lifecycle, defuse, round/match end, mvp.

  private processObjectiveEvents(events: GsiEvent[], out: Beat[]): void {
    for (const evt of events) {
      // Use the GSI event's own timestamp so beats are anchored to when the game
      // action fired, not when the detector happened to run. State-diff beats
      // (processCombat / processCompound) use `now` because there's no discrete
      // source event — only a snapshot delta observed at detect time.
      const at = evt.timestamp;
      switch (evt.event) {
        case "bombPlantStart":
          this.push(out, at, "bombPlantStart", `${evt.playerName ?? "A terrorist"} is going for the plant`, "medium", evt.playerName);
          break;
        case "bombPlantStop":
          this.push(out, at, "bombPlantStop", `${evt.playerName ?? "A terrorist"} is forced off the plant`, "medium", evt.playerName);
          break;
        case "bombPlant":
          this.push(out, at, "bombPlant", `${evt.playerName ?? "A terrorist"} plants the bomb`, "high", evt.playerName);
          break;
        case "bombDefuse":
          this.push(out, at, "bombDefuse", `${evt.playerName ?? "A CT"} defuses the bomb`, "high", evt.playerName);
          break;
        case "bombExplode":
          this.push(out, at, "bombExplode", "The bomb detonates", "high");
          break;
        case "defuseStart":
          this.push(out, at, "defuseStart", `${evt.playerName ?? "A CT"} starts the defuse`, "medium", evt.playerName);
          break;
        case "defuseStop":
          // Defuse was live and got cancelled — genuinely dramatic tension shift.
          this.push(out, at, "defuseStop", `${evt.playerName ?? "A CT"} is forced off the defuse`, "high", evt.playerName);
          break;
        case "roundEnd":
          this.push(out, at, "roundEnd", "Round over", "medium");
          break;
        case "matchEnd":
          this.push(out, at, "matchEnd", "Match over", "high");
          break;
        case "mvp":
          this.push(out, at, "mvp", `${evt.playerName ?? "A player"} takes the round MVP`, "medium", evt.playerName);
          break;
        // freezetime*, timeouts, intermission, kill/hurt: dropped or derived from state diffs.
      }
    }
  }

  // --- 2. Combat + state-diff signals (this window vs the previous) ----------

  private processCombat(prev: GameSnapshot, cur: GameSnapshot, now: number, out: Beat[]): void {
    const prevById = new Map(prev.players.map(p => [p.steamid, p]));

    // Collect this window's kills (round_kills rose) and deaths (alive -> dead).
    const killers: PlayerSnapshot[] = [];
    const victims: PlayerSnapshot[] = [];
    for (const p of cur.players) {
      const before = prevById.get(p.steamid);
      if (!before) continue;
      if (p.killsThisRound > before.killsThisRound) killers.push(p);
      if (before.alive && !p.alive) victims.push(p);
    }

    // Attribute each killer to an opposing-side victim where possible.
    const claimed = new Set<string>();
    for (const killer of killers) {
      const victim = victims.find(v => v.team !== killer.team && !claimed.has(v.steamid));
      if (victim) claimed.add(victim.steamid);

      const isEntry = this.deaths.length === 0 && cur.players.filter(p => !p.alive).length <= 1;
      const isTrade = this.deaths.some(d => d.side === killer.team && now - d.at <= TRADE_WINDOW_MS);
      // Weapon is part of "what happened" — bake it into summary text (unlike the
      // alive count, which goes on its own field so repeat-detection on summary
      // text stays stable across mentions of the same kill).
      const weapon = killer.currentWeapon ? ` with ${killer.currentWeapon}` : "";

      let type = "kill";
      let summary = `${killer.name} frags ${victim?.name ?? "an enemy"}${weapon}`;
      if (isEntry) { type = "entryKill"; summary = `${killer.name} draws first blood on ${victim?.name ?? "an enemy"}${weapon}`; }
      else if (isTrade) { type = "tradeKill"; summary = `${killer.name} trades back ${victim?.name ?? "the kill"}${weapon}`; }
      this.push(out, now, type, summary, "medium", killer.name, killer.location ?? undefined, cur.aliveCT, cur.aliveT);

      // Multi-kill: count only rapid consecutive kills within MULTIKILL_WINDOW_MS.
      // Using total round_kills to track streak depth, but resetting the base
      // whenever a kill arrives too long after the previous one.
      const prevStreak = this.multiKillStreaks.get(killer.steamid);
      const gapMs = prevStreak ? now - prevStreak.lastAt : Infinity;
      // Find the before-snapshot kill count to use as the reset base.
      const beforeKills = prevById.get(killer.steamid)?.killsThisRound ?? 0;
      const base = (!prevStreak || gapMs > MULTIKILL_WINDOW_MS)
        ? beforeKills   // streak broken — this kill starts a fresh one
        : prevStreak.base;
      const announced = prevStreak?.announced ?? 0;
      const streakDepth = killer.killsThisRound - base;
      this.multiKillStreaks.set(killer.steamid, { base, lastAt: now, announced });

      if (streakDepth >= 2 && streakDepth > announced && MULTIKILL_TERMS[streakDepth]) {
        this.multiKillStreaks.set(killer.steamid, { base, lastAt: now, announced: streakDepth });
        this.push(out, now, "multiKill", `${killer.name} — ${MULTIKILL_TERMS[streakDepth]}!`, streakDepth >= 3 ? "high" : "medium", killer.name, killer.location ?? undefined, cur.aliveCT, cur.aliveT);
      }
    }

    // Record deaths (for future trade windows); narrate unattributed deaths lightly.
    for (const v of victims) {
      this.deaths.push({ side: v.team, at: now });
      if (!claimed.has(v.steamid)) {
        this.push(out, now, "death", `${v.name} goes down`, "medium", v.name, v.location ?? undefined, cur.aliveCT, cur.aliveT);
      }
    }

    // Continuous-state edges (deduped per player via cooldown). Firing is
    // aggregated below rather than emitted per player — naming every shooter and
    // weapon floods the broadcast and buries the kills.
    let firingPlayers = 0;
    for (const p of cur.players) {
      const before = prevById.get(p.steamid);
      if (!before || !p.alive) continue;
      if (p.ammoClip != null && before.ammoClip != null && p.ammoClip < before.ammoClip)
        firingPlayers++;
      if (before.flashed < FLASH_THRESHOLD && p.flashed >= FLASH_THRESHOLD)
        this.edge(p, "flashed", now, out, "gotFlashed", `${p.name} is blinded`, "medium");
      if (before.burning === 0 && p.burning > 0)
        this.edge(p, "burning", now, out, "onFire", `${p.name} is caught in fire`, "medium");
      if (before.health > LOW_HP && p.health <= LOW_HP)
        this.edge(p, "lowhp", now, out, "lowHP", `${p.name} is clinging on at ${p.health} HP`, "medium");
    }

    // One ambient "gunfire" beat at most every FIRING_AGGREGATE_MS — just enough
    // to colour a standoff without drowning out the real events.
    if (firingPlayers > 0 && now - this.lastFiringBeat >= FIRING_AGGREGATE_MS) {
      this.lastFiringBeat = now;
      this.push(out, now, "gunfire", "Gunfire is being traded across the map", "low");
    }
  }

  // --- 3. Compound tactical flags -------------------------------------------

  private processCompound(prev: GameSnapshot, snap: GameSnapshot, now: number, out: Beat[]): void {
    // Bomb state transitions — detected by diffing this snapshot against the previous
    // one in the walk, so the beat is stamped at the exact moment the state flipped.
    if (snap.roundPhase === "live") {
      const prevBomb = prev.bombState;
      if (prevBomb === "carried" && snap.bombState === "dropped") {
        // Carrier was killed; bomb is now live on the ground.
        const prevCarrier = prev.players.find(p => p.hasBomb);
        this.push(
          out, now, "bombDropped",
          prevCarrier ? `${prevCarrier.name} drops the bomb` : "The bomb is live on the floor",
          "high",
          prevCarrier?.name
        );
      }
      if (prevBomb === "dropped" && snap.bombState === "carried") {
        const newCarrier = snap.players.find(p => p.hasBomb);
        this.push(
          out, now, "bombPickup",
          newCarrier ? `${newCarrier.name} picks up the bomb` : "The bomb has been recovered",
          "medium",
          newCarrier?.name
        );
      }
    }

    // Clutch: exactly one alive on a side vs >=1 on the other, during live play.
    if (snap.roundPhase === "live" && this.clutchRound !== snap.currentRound) {
      const clutch =
        snap.aliveCT === 1 && snap.aliveT >= 1 ? { side: "CT" as const, vs: snap.aliveT }
        : snap.aliveT === 1 && snap.aliveCT >= 1 ? { side: "T" as const, vs: snap.aliveCT }
        : null;
      if (clutch) {
        const hero = snap.players.find(p => p.team === clutch.side && p.alive);
        this.clutchRound = snap.currentRound;
        this.push(
          out, now, "clutch",
          `${hero?.name ?? clutch.side} is in a 1v${clutch.vs} clutch`,
          clutch.vs >= 2 ? "high" : "medium",
          hero?.name,
          hero?.location ?? undefined
        );
      }
    }

    // Economy read: once per freezetime, classify each team's buy.
    if (snap.roundPhase === "freezetime" && this.economyRound !== snap.currentRound && snap.players.length > 0) {
      this.economyRound = snap.currentRound;
      const ct = tierFor(snap.players.filter(p => p.team === "CT"));
      const t  = tierFor(snap.players.filter(p => p.team === "T"));
      this.push(out, now, "economy", `Buy phase — CT on a ${ct}, T on a ${t}`, "low");
    }
  }

  // --- Tactical situation summary -------------------------------------------
  // Produces a plain-English interpretation of what the current match state
  // MEANS right now — bomb stakes, alive count odds, economy narrative, match
  // situation. This is CS2 game logic and lives here, not in the text layer.

  describeSituation(snap: GameSnapshot): string {
    const parts: string[] = [];

    // Match situation
    const WIN_TARGET = 13; // standard MR12
    const ctMatchPoint = snap.scoreCT >= WIN_TARGET - 1;
    const tMatchPoint  = snap.scoreT  >= WIN_TARGET - 1;
    if (ctMatchPoint && tMatchPoint) {
      parts.push(`MATCH POINT FOR BOTH SIDES — CT ${snap.scoreCT}–${snap.scoreT} T. One round ends the map.`);
    } else if (ctMatchPoint) {
      parts.push(`CT MATCH POINT — CT ${snap.scoreCT}–${snap.scoreT} T. CTs one round from winning the map.`);
    } else if (tMatchPoint) {
      parts.push(`T MATCH POINT — CT ${snap.scoreCT}–${snap.scoreT} T. Ts one round from winning the map.`);
    } else {
      const roundLabel =
        snap.currentRound === 1  ? "Pistol round" :
        snap.currentRound === 13 ? "Second-half pistol round" :
        `Round ${snap.currentRound}`;
      parts.push(`${roundLabel} — CT ${snap.scoreCT}–${snap.scoreT} T.`);
    }

    // Alive counts and what they mean
    if (snap.roundPhase === "live") {
      const { aliveCT, aliveT } = snap;
      const label = `${aliveCT} CT${aliveCT !== 1 ? "s" : ""} vs ${aliveT} T${aliveT !== 1 ? "s" : ""} alive`;
      if (aliveCT === 1 && aliveT === 1) {
        parts.push(`${label} — 1v1, the round comes down to a single duel.`);
      } else if (aliveCT === 1) {
        parts.push(`${label} — CT side in a near-impossible 1v${aliveT} clutch.`);
      } else if (aliveT === 1) {
        parts.push(`${label} — T side down to one player, clutching against ${aliveCT}.`);
      } else {
        parts.push(`${label}.`);
      }
    } else if (snap.roundPhase === "freezetime") {
      parts.push("Buy phase — players purchasing equipment.");
    }

    // Bomb state and what it means for each team
    switch (snap.bombState) {
      case "planted": {
        const cd = snap.bombCountdown;
        const secs = cd != null ? Math.ceil(cd) : null; // ceil so 0.4s isn't shown as 0
        let msg: string;
        if (cd == null) {
          msg = `BOMB PLANTED on ${snap.bombSite ?? "unknown"} site — clock ticking.`;
          msg += " CTs MUST defuse. Ts just need to deny.";
        } else if (cd <= 0) {
          msg = `BOMB DETONATING on ${snap.bombSite ?? "unknown"} site — it is over, no time left.`;
        } else if (cd < 5) {
          msg = `BOMB PLANTED on ${snap.bombSite ?? "unknown"} site — ${secs}s left. DEFUSE IS IMPOSSIBLE: not enough time even with a kit (needs 5s). Ts win unless the bomb is somehow interrupted.`;
        } else if (cd < 10) {
          msg = `BOMB PLANTED on ${snap.bombSite ?? "unknown"} site — ${secs}s left. CRITICAL: defuse is ONLY possible with a kit (~5s). Without a kit a CT cannot defuse in time.`;
          msg += ` ${snap.aliveT} T${snap.aliveT !== 1 ? "s" : ""} defending vs ${snap.aliveCT} CT${snap.aliveCT !== 1 ? "s" : ""} rushing.`;
        } else {
          msg = `BOMB PLANTED on ${snap.bombSite ?? "unknown"} site — ${secs}s on the clock.`;
          msg += " CTs MUST defuse — killing all Ts no longer wins if time runs out.";
          msg += ` Ts just need to survive or deny (${snap.aliveT} T vs ${snap.aliveCT} CT).`;
        }
        parts.push(msg);
        break;
      }
      case "dropped": {
        parts.push("Bomb DROPPED on the floor — carrier was eliminated. Whoever controls that position controls the round: CTs want to lock it down, Ts need to recover it.");
        break;
      }
      case "defusing": {
        parts.push("Bomb is being defused — Ts must interrupt immediately or the round is lost.");
        break;
      }
      case "planting": {
        parts.push("Bomb plant in progress — CTs must interrupt or the round dynamics flip entirely.");
        break;
      }
      case "carried": {
        const carrier = snap.players.find(p => p.hasBomb);
        parts.push(carrier
          ? `Bomb held by ${carrier.name} (T side) — standard attack.`
          : "Bomb in T hands — standard attack.");
        break;
      }
    }

    // Economy (only meaningful during freezetime)
    if (snap.roundPhase === "freezetime" && snap.players.length > 0) {
      const ctTeam = snap.players.filter(p => p.team === "CT");
      const tTeam  = snap.players.filter(p => p.team === "T");
      if (ctTeam.length > 0 && tTeam.length > 0) {
        const ctLabel = tierFor(ctTeam);
        const tLabel  = tierFor(tTeam);
        if (ctLabel !== tLabel) {
          const favored = ctTeam.reduce((s, p) => s + p.equipValue, 0) > tTeam.reduce((s, p) => s + p.equipValue, 0) ? "CT" : "T";
          parts.push(`Economy: CT on ${ctLabel} vs T on ${tLabel} — ${favored} side has the gear advantage; losing here would be an upset.`);
        } else {
          parts.push(`Economy: both teams on ${ctLabel} — even matchup.`);
        }
      }
    }

    return parts.join("\n");
  }

  // --- helpers --------------------------------------------------------------

  private edge(
    p: PlayerSnapshot, signal: string, now: number,
    out: Beat[], type: string, summary: string, intensity: EventIntensity
  ): void {
    const key = `${p.steamid}:${signal}`;
    if (now - (this.cooldowns.get(key) ?? 0) < COOLDOWN_MS) return;
    this.cooldowns.set(key, now);
    this.push(out, now, type, summary, intensity, p.name, p.location ?? undefined);
  }

  private push(
    out: Beat[], now: number,
    type: string, summary: string, intensity: EventIntensity, player?: string, location?: string,
    aliveCT?: number, aliveT?: number
  ): void {
    out.push({
      id: ++this.serial,
      type,
      summary,
      intensity,
      ...(player ? { players: [player] } : {}),
      ...(location ? { location } : {}),
      ...(aliveCT != null ? { aliveCT } : {}),
      ...(aliveT != null ? { aliveT } : {}),
      timestamp: now,
    });
  }
}

function tierFor(team: PlayerSnapshot[]): string {
  if (team.length === 0) return "unknown buy";
  const avg = team.reduce((s, p) => s + p.equipValue, 0) / team.length;
  if (avg < 1500) return "full eco";
  if (avg < 3500) return "force buy";
  return "full buy";
}
