import fs from "fs";
import http from "http";
import path from "path";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "../utils/logger.js";
import type { IAudioSink } from "../orchestrator/contracts.js";
import type { RenderedClip } from "../types/pipeline.js";

const log = logger.child({ service: "[OverlayServer]" });

// A disconnected/closed client must never hang the conductor — see invariant 6.
const ACK_GRACE_MS = 5000;

const OVERLAY_DIST = path.resolve(process.cwd(), "overlay", "dist");

type OverlayMessage = {
  type: "clip";
  index: number;
  airAt: number;
  durationMs: number;
  transcript: string;
  sourceBeatIds: number[];
};

/**
 * OverlayAudioSink — broadcasts each clip to every connected overlay client
 * (OBS browser source, or any manual monitoring tab) over WebSocket, and
 * serves the clip's audio bytes over plain HTTP so the page's own <audio>
 * element handles buffering/seeking natively.
 *
 * `play()` resolves on whichever connected client acks first (first-ack-wins —
 * there's no single "primary" client, any number of tabs may be open at once),
 * or after a grace period past the clip's own duration if nobody acks at all —
 * so a closed tab or zero connected clients can never stall the broadcast.
 */
export class OverlayAudioSink implements IAudioSink {
  private readonly clients = new Set<WebSocket>();
  private readonly filesByIndex = new Map<number, string>();
  private readonly pendingAcks = new Map<number, () => void>();
  private readonly controlListeners: ((enabled: boolean) => void)[] = [];

  /** Registers a callback fired when any connected client toggles shoutcasting. */
  onControl(cb: (enabled: boolean) => void): void {
    this.controlListeners.push(cb);
  }

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.type === "ack" && typeof msg.index === "number") {
          this.pendingAcks.get(msg.index)?.();
        } else if (msg?.type === "control" && typeof msg.enabled === "boolean") {
          for (const cb of this.controlListeners) cb(msg.enabled);
        }
      } catch (err) {
        log.warn({ err }, "discarding malformed client message");
      }
    });
  }

  resolveFile(index: number): string | undefined {
    return this.filesByIndex.get(index);
  }

  async play(clip: RenderedClip): Promise<void> {
    this.filesByIndex.set(clip.index, clip.filePath);

    const message: OverlayMessage = {
      type: "clip",
      index: clip.index,
      airAt: Date.now(),
      durationMs: clip.durationMs,
      transcript: clip.transcript,
      sourceBeatIds: clip.sourceBeatIds,
    };
    this.broadcast(message);

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return; // first-ack-wins; later acks/timeout are no-ops
        settled = true;
        this.pendingAcks.delete(clip.index);
        clearTimeout(timer);
        resolve();
      };
      this.pendingAcks.set(clip.index, finish);
      const timer = setTimeout(() => {
        log.warn({ index: clip.index }, "no overlay client acked in time — proceeding anyway");
        finish();
      }, clip.durationMs + ACK_GRACE_MS);
    });

    this.filesByIndex.delete(clip.index);
  }

  private broadcast(message: OverlayMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of this.clients) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      } catch (err) {
        log.warn({ err }, "failed to send to overlay client — dropping it");
        this.clients.delete(ws);
      }
    }
  }
}

export function startOverlayService(port: number): { sink: OverlayAudioSink } {
  const sink = new OverlayAudioSink();
  const app = express();

  if (fs.existsSync(OVERLAY_DIST)) {
    app.use(express.static(OVERLAY_DIST));
  } else {
    log.warn({ path: OVERLAY_DIST }, "overlay/dist not found — run `npm run build` in overlay/ to serve it here");
  }

  app.get("/overlay/clip/:file", (req, res) => {
    const match = /^(\d+)\.wav$/.exec(req.params.file);
    const filePath = match ? sink.resolveFile(Number(match[1])) : undefined;
    if (!filePath) {
      res.sendStatus(404);
      return;
    }
    res.setHeader("Content-Type", "audio/wav");
    const stream = fs.createReadStream(filePath);
    stream.on("error", (err) => {
      log.error({ err, filePath }, "failed to stream clip audio");
      if (!res.headersSent) res.sendStatus(500);
    });
    stream.pipe(res);
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/overlay/ws" });
  wss.on("connection", (ws) => {
    log.info("overlay client connected");
    sink.addClient(ws);
  });

  server.listen(port, () => {
    log.info({ port }, `overlay service listening on ${port}`);
  });

  return { sink };
}
