import fs from "fs";
import path from "path";
import express from "express";
import { CSGOGSI } from "csgogsi";
import type { CSGO, CSGORaw, HurtEvent, KillEvent, Player, Score, Team } from "csgogsi";
import { logger } from "../../utils/logger.js";
import { eventEmoji } from "../../utils/eventEmoji.js";
import { ARTIFACT_DIR } from "../../utils/tempDir.js";

const log = logger.child({ service: "[GsiListener]" });

const DUMP_PATH = path.join(ARTIFACT_DIR, "gsi-dump.jsonl");

export type GsiStateHandler = (data: CSGO) => void;
export type GsiEventHandler = (id: number, eventName: string, data: unknown, playerName?: string) => void;

export function startGsiService(
  port: number,
  onData: GsiStateHandler,
  onEvent: GsiEventHandler
): void {
  // Clear the dump file at startup so each run starts fresh.
  fs.writeFileSync(DUMP_PATH, "", "utf8");
  log.info({ path: DUMP_PATH }, "GSI dump file cleared");

  const gsi = new CSGOGSI();
  let serial = 0;

  function emit(name: string, data: unknown, playerName?: string): void {
    const id = ++serial;
    log.debug(
      { id, event: name, playerName },
      `${eventEmoji(name)} #${id} ${name}${playerName ? ` [${playerName}]` : ""}`
    );
    onEvent(id, name, data, playerName);
  }

  gsi.on("data", onData);

  gsi.on("kill",             (e: KillEvent) => emit("kill",             e, e.killer?.name ?? undefined));
  gsi.on("hurt",             (e: HurtEvent) => emit("hurt",             e, e.attacker?.name));
  gsi.on("mvp",              (p: Player)    => emit("mvp",              p, p.name));
  gsi.on("bombPlantStart",   (p: Player)    => emit("bombPlantStart",   p, p.name));
  gsi.on("bombPlantStop",    (p: Player)    => emit("bombPlantStop",    p, p.name));
  gsi.on("bombPlant",        (p: Player)    => emit("bombPlant",        p, p.name));
  gsi.on("bombExplode",      ()             => emit("bombExplode",      null));
  gsi.on("bombDefuse",       (p: Player)    => emit("bombDefuse",       p, p.name));
  gsi.on("defuseStart",      (p: Player)    => emit("defuseStart",      p, p.name));
  gsi.on("defuseStop",       (p: Player)    => emit("defuseStop",       p, p.name));
  gsi.on("roundEnd",         (s: Score)     => emit("roundEnd",         s));
  gsi.on("matchEnd",         (s: Score)     => emit("matchEnd",         s));
  gsi.on("freezetimeStart",  ()             => emit("freezetimeStart",  null));
  gsi.on("freezetimeEnd",    ()             => emit("freezetimeEnd",    null));
  gsi.on("timeoutStart",     (t: Team)      => emit("timeoutStart",     t));
  gsi.on("timeoutEnd",       ()             => emit("timeoutEnd",       null));
  gsi.on("intermissionStart",()             => emit("intermissionStart",null));
  gsi.on("intermissionEnd",  ()             => emit("intermissionEnd",  null));

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  app.post("/", (req, res) => {
    const raw = req.body as CSGORaw;
    // Append raw payload to dump file before any parsing.
    fs.appendFileSync(DUMP_PATH, JSON.stringify({ receivedAt: Date.now(), body: raw }) + "\n", "utf8");
    log.trace({ body: raw }, "raw GSI payload");
    try {
      const parsed = gsi.digest(raw);
      if (!parsed) {
        log.warn({ keys: Object.keys(raw) }, "⚠️  digest() returned null — payload missing required fields (allplayers/map?)");
      }
    } catch (err) {
      // A malformed frame must never take down the listener.
      log.error({ err, keys: Object.keys(raw) }, "digest() threw on payload");
    }
    res.sendStatus(200);
  });

  app.listen(port, () => {
    log.info({ port }, `GSI listening on port ${port}`);
  });
}
