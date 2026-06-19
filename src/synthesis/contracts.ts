import type { Beat, Passage } from "../types/pipeline.js";
import type { GameSnapshot } from "../types/game.js";

/** Everything the commentary writer needs to narrate one batch as a passage. */
export interface CommentaryContext {
  /** Monotonic batch index — used in logs to correlate with the rest of the pipeline. */
  batchIndex: number;
  /** The batch of beats to narrate now, in the order they happened. */
  beats: Beat[];
  /** Match state captured when the batch sealed. */
  snapshot: GameSnapshot;
  /** The caster's recent passages — its shoutcast history, to continue from. */
  passageHistory: Passage[];
  /**
   * Plain-English interpretation of what the match state means RIGHT NOW —
   * bomb stakes, alive count odds, economy narrative, match situation.
   * Produced by BeatDetector, not the commentary layer.
   */
  tacticalContext: string;
  /** Batches still waiting behind this one (sealedQueue + batcher pending),
   *  captured when this batch was picked up. Drives pacing under backlog. */
  queueDepth: number;
}

/** Result of a commentary call: the two views of one commentary passage. */
export interface CommentaryResult {
  /** Full text handed to the speech synthesizer — may carry TTS-only scaffolding. */
  speech: string;
  /** Spoken words only — what the caster actually says, recorded in the history. */
  transcript: string;
  /** The user-turn content this call was built from — handed back so the
   *  caller can store it on the resulting Passage for future replay. */
  userTurn: string;
  /**
   * The timestamp of the beat this passage actually opens on. Equals the batch's
   * first beat when the LLM narrated it; otherwise the LLM skipped the batch's
   * leading beat(s) and this is the timestamp of the one it actually starts from —
   * the caller should schedule/record the clip at THIS time, not the batch's
   * nominal anchor, so the audio doesn't air earlier than the moment it describes.
   */
  effectiveAnchorTs: number;
}

/**
 * The commentary brain: turns a batch of beats into one spoken passage. The
 * implementation is game-specific (it carries the game's vocabulary and caster
 * persona); this interface is the game-agnostic seam the orchestrator depends on.
 */
export interface ICommentaryWriter {
  write(ctx: CommentaryContext): Promise<CommentaryResult | null>;
}

/** Turns a written passage into a spoken audio file via a TTS provider. */
export interface ISpeechSynthesizer {
  synthesizeToFile(text: string): Promise<string | null>;
}
