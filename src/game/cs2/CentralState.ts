import type { CSGO, Player } from "csgogsi";
import type { GameSnapshot, TimedSnapshot, PlayerSnapshot, RoundPhase, BombState } from "../../types/game.js";
import type { NavMap } from "./NavMap.js";
import { logger } from "../../utils/logger.js";

const log = logger.child({ service: "[CentralState]" });

// How long timestamped snapshots are retained in the ring — generous headroom so the
// interpreter and lull filler can always look back to the moment they're processing.
const SNAPSHOT_RETAIN_MS = 35_000;

/**
 * CentralState — "The Memory".
 *
 * Holds a single normalized GameSnapshot updated on every GSI data tick.
 * Logs only when meaningful fields change to avoid flooding on every tick.
 */
export class CentralState {
  constructor(private readonly navMap: NavMap) {}

  private snapshot: GameSnapshot = {
    currentMap: "",
    roundPhase: "warmup",
    scoreCT: 0,
    scoreT: 0,
    currentRound: 0,
    bombState: "dropped",
    bombCountdown: null,
    bombSite: null,
    aliveCT: 0,
    aliveT: 0,
    players: [],
  };

  /** Timestamped ring of recent snapshots — fuels the interpreter's snapshot walk. */
  private history: TimedSnapshot[] = [];

  /**
   * All-time roster — every player ever seen, by steamid, with their last-known
   * name/side and when they were last seen. Side-channel source of truth, not a
   * substitute for per-tick alive counts (those are recomputed fresh below and
   * are already verified correct against real GSI captures). The roster's only
   * job is to surface a warning if a future tick ever drops players it expects
   * to still be around — something never observed in practice but worth catching
   * if it ever happens.
   */
  private roster = new Map<string, { name: string; team: "CT" | "T"; lastSeenTs: number }>();

  // How recently a player must have been seen to count as "should still be
  // present" for the under-count warning below. Generous enough to cover a
  // missed GSI tick or two without false-alarming on a genuine disconnect.
  private static readonly ROSTER_RECENT_MS = 10_000;

  applyData(data: CSGO): void {
    const prev = this.snapshot;

    const nextMap     = data.map?.name   ?? prev.currentMap;
    const nextRound   = data.map?.round  ?? prev.currentRound;
    const nextScoreCT = data.map?.team_ct?.score ?? prev.scoreCT;
    const nextScoreT  = data.map?.team_t?.score  ?? prev.scoreT;
    const nextPhase   = deriveRoundPhase(data);
    const nextBomb    = (data.bomb?.state ?? prev.bombState) as BombState;
    const bombCarrier = data.bomb?.player?.steamid;
    const nextPlayers = data.players.map(p => toPlayerSnapshot(p, bombCarrier, this.navMap, nextMap));
    const aliveCT     = nextPlayers.filter(p => p.team === "CT" && p.alive).length;
    const aliveT      = nextPlayers.filter(p => p.team === "T"  && p.alive).length;

    const now = Date.now();
    this.updateRoster(nextPlayers, now);

    // Log only meaningful state transitions — applyData runs on every GSI
    // packet, so per-tick logging would flood. The raw payload is already
    // available at trace level in GsiListener.
    if (nextPhase !== prev.roundPhase)
      log.info({ from: prev.roundPhase, to: nextPhase }, `🔄 phase: ${prev.roundPhase} → ${nextPhase}`);
    if (nextBomb !== prev.bombState)
      log.info({ from: prev.bombState, to: nextBomb }, `💣 bomb: ${prev.bombState} → ${nextBomb}`);
    if (nextRound !== prev.currentRound)
      log.info({ round: nextRound }, `🔢 round: ${prev.currentRound} → ${nextRound}`);
    if (nextScoreCT !== prev.scoreCT || nextScoreT !== prev.scoreT)
      log.info({ ct: nextScoreCT, t: nextScoreT }, `🏆 score: CT ${nextScoreCT} – T ${nextScoreT}`);
    if (nextMap !== prev.currentMap)
      log.info({ map: nextMap }, `🗺️  map: ${nextMap}`);
    if (nextPlayers.length !== prev.players.length)
      log.info({ count: nextPlayers.length }, `👥 players: ${nextPlayers.length}`);

    this.snapshot = {
      currentMap:    nextMap,
      currentRound:  nextRound,
      scoreCT:       nextScoreCT,
      scoreT:        nextScoreT,
      roundPhase:    nextPhase,
      bombState:     nextBomb,
      bombCountdown: data.bomb?.countdown ?? null,
      bombSite:      data.bomb?.site ?? null,
      aliveCT,
      aliveT,
      players:       nextPlayers,
    };

    // Append to the ring and prune anything past the retention horizon.
    this.history.push({ ts: now, snapshot: this.snapshot });
    const cutoff = now - SNAPSHOT_RETAIN_MS;
    while (this.history.length > 0 && this.history[0].ts < cutoff) {
      this.history.shift();
    }
  }

  /**
   * Merge this tick's players into the roster, then warn if anyone the roster
   * expects to still be around (seen within ROSTER_RECENT_MS) is missing from
   * this tick — the signal that would catch a real GSI hiccup, without ever
   * fabricating data into the snapshot itself.
   */
  private updateRoster(players: PlayerSnapshot[], now: number): void {
    const present = new Set(players.map(p => p.steamid));
    for (const p of players) {
      this.roster.set(p.steamid, { name: p.name, team: p.team, lastSeenTs: now });
    }

    const missing: string[] = [];
    for (const [steamid, r] of this.roster) {
      if (!present.has(steamid) && now - r.lastSeenTs < CentralState.ROSTER_RECENT_MS) {
        missing.push(`${r.name} (${r.team})`);
      }
    }
    if (missing.length > 0) {
      log.trace({ missing }, `⚠️  ${missing.length} recently-seen player(s) missing from this GSI tick: ${missing.join(", ")}`);
    }
  }

  /** Snapshots observed in `(from, to]`, chronological. Powers the interpreter's walk. */
  getSnapshotsBetween(from: number, to: number): TimedSnapshot[] {
    return this.history.filter(h => h.ts > from && h.ts <= to);
  }

  /** Most recent snapshot at or before `ts`, or null if the ring has nothing that old. */
  getSnapshotBefore(ts: number): GameSnapshot | null {
    let chosen: TimedSnapshot | null = null;
    for (const h of this.history) {
      if (h.ts <= ts) chosen = h;
      else break;
    }
    return chosen ? { ...chosen.snapshot, players: [...chosen.snapshot.players] } : null;
  }

  /** The most recent snapshot at or before `ts` (falls back to the live one if the ring
   *  predates `ts`). Used by the lull filler to describe what's on the delayed screen. */
  getSnapshotAt(ts: number): GameSnapshot {
    let chosen: GameSnapshot | null = null;
    for (const h of this.history) {
      if (h.ts <= ts) chosen = h.snapshot;
      else break;
    }
    const snap = chosen ?? this.snapshot;
    return { ...snap, players: [...snap.players] };
  }
}

// Priority order matters: round.phase is the most granular (freezetime/live/over);
// map.phase catches warmup and intermission which have no round equivalent.
function deriveRoundPhase(data: CSGO): RoundPhase {
  if (data.map?.phase === "warmup") return "warmup";
  if (data.round?.phase) return data.round.phase as RoundPhase;
  if (data.map?.phase === "intermission" || data.map?.phase === "gameover") return "over";
  return "live";
}

function toPlayerSnapshot(p: Player, bombCarrier: string | undefined, navMap: NavMap, map: string): PlayerSnapshot {
  const active = p.weapons.find(w => w.state === "active" || w.state === "reloading");
  return {
    steamid:        p.steamid,
    name:           p.name,
    team:           p.team.side,
    alive:          p.state.health > 0,
    health:         p.state.health,
    armor:          p.state.armor,
    money:          p.state.money,
    equipValue:     p.state.equip_value,
    killsThisRound: p.state.round_kills,
    currentWeapon:  active ? active.name.replace(/^weapon_/, "") : "",
    ammoClip:       active?.ammo_clip ?? null,
    reloading:      active?.state === "reloading",
    flashed:        p.state.flashed,
    burning:        p.state.burning,
    hasBomb:        bombCarrier ? p.steamid === bombCarrier : p.weapons.some(w => w.type === "C4"),
    hasDefuseKit:   p.state.defusekit === true,
    location:       navMap.locate(map, p.position),
  };
}
