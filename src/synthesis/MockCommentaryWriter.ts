import type { ICommentaryWriter, CommentaryContext, CommentaryResult } from "./contracts.js";
import { logger } from "../utils/logger.js";

const log = logger.child({ service: "[MockCommentaryWriter]" });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class MockCommentaryWriter implements ICommentaryWriter {
  private readonly delayMs: number;

  constructor(delayMs: number) {
    this.delayMs = delayMs;
  }

  async write(ctx: CommentaryContext): Promise<CommentaryResult | null> {
    const { beats, snapshot, passageHistory } = ctx;
    if (beats.length === 0) return null;
    await sleep(this.delayMs);
    const preview = beats.map((b) => b.summary).join("; ");
    // Echo the passage-history length so tests can assert ordering/continuity.
    const text = `[MOCK#${passageHistory.length}] ${snapshot.roundPhase} | ${preview}`;
    log.info(
      {
        beatCount: beats.length,
        historyCount: passageHistory.length,
        delayMs: this.delayMs,
      },
      `synthesized: "${text.slice(0, 80)}"`
    );
    return { speech: text, transcript: text };
  }
}
