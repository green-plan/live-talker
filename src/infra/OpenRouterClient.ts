import { logger } from "../utils/logger.js";

const log = logger.child({ service: "[OpenRouterClient]" });

const BASE_URL = "https://openrouter.ai/api/v1";
const RATE_WINDOW_MS = 60_000;

export interface OpenRouterClientLimits {
  maxCallsPerSession?: number; // hard ceiling on total calls for this process; undefined = no cap
  ratePerMinute?: number;      // max calls in any trailing 60s window; undefined = unlimited
}

export class OpenRouterClient {
  private callCount = 0;
  private capLogged = false;
  private recentCallTimes: number[] = [];

  constructor(
    private readonly apiKey: string,
    private readonly limits: OpenRouterClientLimits = {}
  ) {}

  async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await this.request(path, body);
    return res.json() as T;
  }

  async postBinary(path: string, body: unknown): Promise<Buffer> {
    const res = await this.request(path, body);
    return Buffer.from(await res.arrayBuffer());
  }

  // Sliding window, not a fixed min-interval: concurrent calls (text + the parallel speech
  // pool) all pass through immediately as long as the trailing-60s count is under the limit.
  private async awaitRateLimit(): Promise<void> {
    const { ratePerMinute } = this.limits;
    if (!ratePerMinute) return;

    for (;;) {
      const now = Date.now();
      this.recentCallTimes = this.recentCallTimes.filter((t) => now - t < RATE_WINDOW_MS);
      if (this.recentCallTimes.length < ratePerMinute) {
        this.recentCallTimes.push(now);
        return;
      }
      const waitMs = RATE_WINDOW_MS - (now - this.recentCallTimes[0]);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  private async request(path: string, body: unknown): Promise<Response> {
    const { maxCallsPerSession } = this.limits;

    // Hard backstop against a bug (e.g. a runaway loop) generating unbounded billed calls.
    if (maxCallsPerSession !== undefined && this.callCount >= maxCallsPerSession) {
      if (!this.capLogged) {
        log.error({ maxCallsPerSession }, "session call cap reached — refusing further OpenRouter calls");
        this.capLogged = true;
      }
      throw new Error(`OpenRouter session call cap reached (${maxCallsPerSession})`);
    }

    await this.awaitRateLimit();
    this.callCount++;

    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`HTTP ${res.status}: ${detail}`);
    }
    return res;
  }
}
