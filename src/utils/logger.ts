import pino from "pino";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const isDev = process.env.NODE_ENV !== "production";
const level = process.env.LOG_LEVEL ?? "info";

// Persist console output to ./temp/app.log, wiped on each startup (mirrors the
// GSI dump) so a session's logs are reviewable without scrolling the terminal —
// and without cluttering the repo root. Computed locally rather than importing
// ARTIFACT_DIR to keep the logger free of any heavier module's import side effects.
const LOG_DIR = path.resolve(process.cwd(), "temp");
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "app.log");
fs.writeFileSync(LOG_FILE, "");

const prettyOptions = {
  translateTime: "SYS:HH:MM:ss.l",
  // service is embedded in messageFormat; suppress it as a separate field.
  ignore: "pid,hostname,service",
  messageKey: "msg",
  messageFormat: "{service} {msg}",
};

export const logger = pino({
  level,
  transport: {
    targets: [
      // Console — pretty in dev, raw JSON in production.
      isDev
        ? { target: "pino-pretty", level, options: { ...prettyOptions, colorize: true } }
        : { target: "pino/file", level, options: { destination: 1 } },
      // Persisted session log — always pretty (no color) so the file reads like the console.
      { target: "pino-pretty", level, options: { ...prettyOptions, colorize: false, destination: LOG_FILE } },
    ],
  },
});
