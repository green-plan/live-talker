import type { GsiEvent } from "../types/game.js";

/**
 * GameEventBuffer — "The Journal".
 *
 * Rolling log of structured events. Protects data during heavy firefights
 * while capping memory use at capacity entries. Generic so it can hold raw
 * GsiEvents (ingestion) or Beats (the meaningful queue).
 */
export class GameEventBuffer<T = GsiEvent> {
  private events: T[] = [];
  private readonly capacity: number;

  /** @param capacity Max events retained before the oldest are dropped (ring-buffer behaviour). */
  constructor(capacity = 1000) {
    this.capacity = capacity;
  }

  addEvent(evt: T): void {
    this.events.push(evt);
    if (this.events.length > this.capacity) {
      this.events.shift();
    }
  }

  /**
   * Return and remove every event with `timestamp <= cutoff`, retaining newer ones
   * for a later window. Used by the interpreter's watermark to drain exactly the
   * events up to the point it's processing. Order is preserved. Entries must carry
   * a numeric `timestamp`.
   */
  flushOlderThan(cutoff: number): T[] {
    const ready: T[] = [];
    const keep: T[] = [];
    for (const e of this.events) {
      const ts = (e as { timestamp?: number }).timestamp ?? 0;
      if (ts <= cutoff) ready.push(e);
      else keep.push(e);
    }
    this.events = keep;
    return ready;
  }
}
