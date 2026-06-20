import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenRouterClient, type OpenRouterClientLimits } from "../src/infra/OpenRouterClient";

/** Build a fake `fetch` that records each call and returns a canned JSON Response. */
function fakeFetch(impl?: (url: string, init: RequestInit) => Partial<Response> & { _json?: unknown }) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const out = impl?.(url, init) ?? {};
    const json = (out as { _json?: unknown })._json ?? { ok: true };
    return {
      ok: out.ok ?? true,
      status: out.status ?? 200,
      json: async () => json,
      text: async () => JSON.stringify(json),
      arrayBuffer: async () => new ArrayBuffer(8),
      ...out,
    } as unknown as Response;
  });
}

function makeClient(limits: OpenRouterClientLimits = {}) {
  const fetchMock = fakeFetch();
  vi.stubGlobal("fetch", fetchMock);
  const client = new OpenRouterClient("test-key", limits);
  return { client, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("OpenRouterClient", () => {
  describe("request basics", () => {
    it("posts JSON to the OpenRouter base URL with auth headers", async () => {
      const { client, fetchMock } = makeClient();
      await client.postJson("/chat/completions", { hello: "world" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
      expect(init.body).toBe(JSON.stringify({ hello: "world" }));
    });

    it("returns a Buffer from postBinary", async () => {
      const { client } = makeClient();
      const buf = await client.postBinary("/audio", { say: "hi" });
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBe(8);
    });

    it("throws with status and detail on a non-OK response", async () => {
      const fetchMock = fakeFetch(() => ({ ok: false, status: 429, _json: "rate limited" }));
      vi.stubGlobal("fetch", fetchMock);
      const client = new OpenRouterClient("k");
      await expect(client.postJson("/x", {})).rejects.toThrow(/HTTP 429/);
    });
  });

  describe("maxCallsPerSession (hard session cap)", () => {
    it("allows calls up to the cap then refuses further ones", async () => {
      const { client, fetchMock } = makeClient({ maxCallsPerSession: 2 });

      await client.postJson("/x", {});
      await client.postJson("/x", {});
      await expect(client.postJson("/x", {})).rejects.toThrow(/session call cap reached \(2\)/);

      // The refused call never reaches the network.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("keeps refusing every call once the cap is hit", async () => {
      const { client } = makeClient({ maxCallsPerSession: 1 });
      await client.postJson("/x", {});
      await expect(client.postJson("/x", {})).rejects.toThrow(/cap reached/);
      await expect(client.postJson("/x", {})).rejects.toThrow(/cap reached/);
    });

    it("treats an undefined cap as unlimited", async () => {
      const { client, fetchMock } = makeClient({});
      for (let i = 0; i < 5; i++) await client.postJson("/x", {});
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });
  });

  describe("maxRequestChars (oversized prompt guard)", () => {
    it("rejects a body whose serialized length exceeds the cap, before any fetch", async () => {
      const { client, fetchMock } = makeClient({ maxRequestChars: 20 });
      const big = { prompt: "x".repeat(100) };
      await expect(client.postJson("/x", big)).rejects.toThrow(/request body too large/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("allows a body at or under the cap", async () => {
      const body = { a: 1 };
      const exact = JSON.stringify(body).length;
      const { client, fetchMock } = makeClient({ maxRequestChars: exact });
      await client.postJson("/x", body);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not consume a session call slot when it rejects", async () => {
      // Cap of 1 call: an oversized request must not eat the only slot.
      const { client, fetchMock } = makeClient({ maxCallsPerSession: 1, maxRequestChars: 20 });
      await expect(client.postJson("/x", { prompt: "x".repeat(100) })).rejects.toThrow(/too large/);
      await client.postJson("/x", { a: 1 }); // still allowed
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("measures characters, not bytes (multi-byte chars count as one)", async () => {
      // "€" is 3 bytes but 1 char. A 10-char euro string serializes well under 20 chars
      // of JSON overhead-free payload, so a char-based cap passes where a byte cap would fail.
      const body = "€".repeat(10); // JSON.stringify → "\"€€…€\"" = 12 chars, 32 bytes
      const payloadLen = JSON.stringify(body).length;
      expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeGreaterThan(payloadLen);
      const { client, fetchMock } = makeClient({ maxRequestChars: payloadLen });
      await client.postJson("/x", body);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("treats an undefined cap as no limit", async () => {
      const { client, fetchMock } = makeClient({});
      await client.postJson("/x", { prompt: "x".repeat(1_000_000) });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("ratePerMinute (trailing-60s sliding window)", () => {
    it("lets calls through immediately while under the limit", async () => {
      vi.useFakeTimers();
      const { client, fetchMock } = makeClient({ ratePerMinute: 3 });
      await Promise.all([
        client.postJson("/x", {}),
        client.postJson("/x", {}),
        client.postJson("/x", {}),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("delays a call past the limit until the window frees up", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const { client, fetchMock } = makeClient({ ratePerMinute: 2 });

      // Two immediate, one queued.
      void client.postJson("/x", {});
      void client.postJson("/x", {});
      const third = client.postJson("/x", {});

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2); // third is still waiting

      // Advance past the 60s window; the two earliest timestamps age out.
      await vi.advanceTimersByTimeAsync(60_000);
      await third;
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("prunes expired timestamps so steady low-rate traffic never blocks", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const { client, fetchMock } = makeClient({ ratePerMinute: 1 });

      await client.postJson("/x", {});
      await vi.advanceTimersByTimeAsync(60_001); // window fully elapses
      await client.postJson("/x", {});
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("treats an undefined rate as unlimited", async () => {
      const { client, fetchMock } = makeClient({});
      for (let i = 0; i < 10; i++) await client.postJson("/x", {});
      expect(fetchMock).toHaveBeenCalledTimes(10);
    });
  });
});
