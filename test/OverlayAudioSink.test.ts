import { describe, it, expect, vi, afterEach } from "vitest";
import { WebSocket } from "ws";
import { OverlayAudioSink } from "../src/infra/OverlayServer";
import type { RenderedClip } from "../src/types/pipeline";

function clip(index: number, durationMs: number): RenderedClip {
  return {
    index,
    anchorTs: Date.now(),
    filePath: `/tmp/clip${index}.wav`,
    sourceBeatIds: [index],
    transcript: `clip ${index}`,
    durationMs,
    ttsMs: 1,
  };
}

/** Minimal stand-in for a `ws` WebSocket — just enough surface for OverlayAudioSink. */
class FakeSocket {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  private readonly listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  on(event: string, cb: (...args: unknown[]) => void): void {
    (this.listeners[event] ??= []).push(cb);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners[event] ?? []) cb(...args);
  }
}

describe("OverlayAudioSink", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves play() as soon as a connected client acks", async () => {
    const sink = new OverlayAudioSink();
    const client = new FakeSocket();
    sink.addClient(client as unknown as WebSocket);

    const c = clip(1, 5000);
    const donePromise = sink.play(c);

    expect(sink.resolveFile(1)).toBe(c.filePath);
    expect(client.sent).toHaveLength(1);
    expect(JSON.parse(client.sent[0])).toMatchObject({ type: "clip", index: 1, durationMs: 5000 });

    client.emit("message", JSON.stringify({ type: "ack", index: 1 }));
    await donePromise;

    expect(sink.resolveFile(1)).toBeUndefined(); // cleaned up after resolving
  });

  it("ignores a second ack for the same index (first-ack-wins)", async () => {
    const sink = new OverlayAudioSink();
    const client = new FakeSocket();
    sink.addClient(client as unknown as WebSocket);

    const donePromise = sink.play(clip(1, 5000));
    client.emit("message", JSON.stringify({ type: "ack", index: 1 }));
    // A late duplicate ack must not throw or hang a second resolution.
    expect(() => client.emit("message", JSON.stringify({ type: "ack", index: 1 }))).not.toThrow();
    await donePromise;
  });

  it("never crashes on a malformed client message", async () => {
    const sink = new OverlayAudioSink();
    const client = new FakeSocket();
    sink.addClient(client as unknown as WebSocket);

    const donePromise = sink.play(clip(1, 10));
    expect(() => client.emit("message", "not json")).not.toThrow();
    client.emit("message", JSON.stringify({ type: "ack", index: 1 }));
    await donePromise;
  });

  it("times out and resolves anyway when nobody acks", async () => {
    vi.useFakeTimers();
    const sink = new OverlayAudioSink();
    // Zero connected clients — nobody can ever ack.
    const donePromise = sink.play(clip(1, 1000));

    let settled = false;
    void donePromise.then(() => (settled = true));

    await vi.advanceTimersByTimeAsync(1000 + 5000 - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toBe(true);
  });

  it("fires registered onControl callbacks when a client sends a control message", () => {
    const sink = new OverlayAudioSink();
    const client = new FakeSocket();
    sink.addClient(client as unknown as WebSocket);

    const calls: boolean[] = [];
    sink.onControl((enabled) => calls.push(enabled));

    client.emit("message", JSON.stringify({ type: "control", enabled: false }));
    client.emit("message", JSON.stringify({ type: "control", enabled: true }));
    expect(calls).toEqual([false, true]);
  });

  it("ignores a control message with a non-boolean enabled field", () => {
    const sink = new OverlayAudioSink();
    const client = new FakeSocket();
    sink.addClient(client as unknown as WebSocket);

    const calls: boolean[] = [];
    sink.onControl((enabled) => calls.push(enabled));
    expect(() => client.emit("message", JSON.stringify({ type: "control", enabled: "nope" }))).not.toThrow();
    expect(calls).toEqual([]);
  });

  it("evicts a socket that throws on send instead of letting the error propagate", async () => {
    const sink = new OverlayAudioSink();
    const bad = new FakeSocket();
    bad.send = () => { throw new Error("socket gone"); };
    const good = new FakeSocket();
    sink.addClient(bad as unknown as WebSocket);
    sink.addClient(good as unknown as WebSocket);

    const donePromise = sink.play(clip(1, 10));
    expect(good.sent).toHaveLength(1); // the good client still got the broadcast

    good.emit("message", JSON.stringify({ type: "ack", index: 1 }));
    await donePromise;
  });
});
