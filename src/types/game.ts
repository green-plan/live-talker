export type RoundPhase = 'freezetime' | 'live' | 'over' | 'warmup';

export type BombState =
  | 'carried'
  | 'dropped'
  | 'planting'
  | 'planted'
  | 'defusing'
  | 'defused'
  | 'exploded';

/** Per-player snapshot derived from a csgogsi CSGO frame by CentralState. */
export interface PlayerSnapshot {
  steamid: string;
  name: string;
  team: 'CT' | 'T';
  /** health > 0; false once the player dies mid-round. */
  alive: boolean;
  health: number;
  armor: number;
  money: number;
  /** Total value of all equipped gear (csgogsi equip_value). Used to classify buy tier. */
  equipValue: number;
  /** round_kills from csgogsi state — resets each round. Used for multi-kill detection. */
  killsThisRound: number;
  /** Active weapon name with "weapon_" prefix stripped (e.g. "ak47", "awp"). */
  currentWeapon: string;
  /** Current clip ammo of the active weapon; null when no active weapon or melee. */
  ammoClip: number | null;
  reloading: boolean;
  /** csgogsi flashed value 0–255; ≥100 is treated as effectively blind. */
  flashed: number;
  /** csgogsi burning value; >0 means the player is taking molotov/incendiary damage. */
  burning: number;
  hasBomb: boolean;
  hasDefuseKit: boolean;
  /** Map callout the player is currently standing in (e.g. "BodyShop"), null if unknown. */
  location: string | null;
}

/** Normalized macro-context of the live match, owned by CentralState. */
export interface GameSnapshot {
  currentMap: string;
  roundPhase: RoundPhase;
  scoreCT: number;
  scoreT: number;
  currentRound: number;
  bombState: BombState;
  /** Seconds until detonation while bomb is planted; null otherwise. */
  bombCountdown: number | null;
  bombSite: 'A' | 'B' | null;
  /** Number of CT players currently alive (health > 0). */
  aliveCT: number;
  /** Number of T players currently alive (health > 0). */
  aliveT: number;
  players: PlayerSnapshot[];
}

/** A GameSnapshot tagged with the wall-clock time it was observed (GSI receive time).
 *  CentralState retains a ring of these so the interpreter can walk consecutive snapshots
 *  within a settled window and stamp each derived beat with the exact moment it appeared. */
export interface TimedSnapshot {
  ts: number;
  snapshot: GameSnapshot;
}

/** A raw structured GSI event as stored in GameEventBuffer. */
export interface GsiEvent {
  id: number;
  event: string;
  playerName?: string;
  data: unknown;
  timestamp: number;
}
