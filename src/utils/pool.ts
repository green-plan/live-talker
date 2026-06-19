/**
 * A minimal concurrency limiter. `submit(task)` runs the task as soon as a slot
 * is free (up to `concurrency` at once) and resolves with its result. Used by the
 * SpeechStage to render many clips in parallel behind the ordered LLM without
 * spawning an unbounded number of in-flight TTS calls.
 */
export class Pool {
  private readonly concurrency: number;
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(concurrency: number) {
    this.concurrency = Math.max(1, concurrency);
  }

  /** Number of tasks currently running. */
  get running(): number {
    return this.active;
  }

  /** Number of tasks waiting for a free slot. */
  get waiting(): number {
    return this.queue.length;
  }

  submit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            const next = this.queue.shift();
            if (next) next();
          });
      };
      if (this.active < this.concurrency) run();
      else this.queue.push(run);
    });
  }
}
