/**
 * Replay a gsi-dump.jsonl file against the running app.
 *
 * Usage:
 *   npm run replay                             # replay temp/gsi-dump.jsonl → localhost:3000
 *   npm run replay -- src/__tests__/fixtures/sample-dump.jsonl
 *   npm run replay -- path/to/dump.jsonl http://localhost:3000
 *
 * Each entry in the dump carries a `receivedAt` wall-clock timestamp.
 * The script waits the same number of milliseconds between POSTs as elapsed
 * between the original events, so the app experiences realistic timing.
 *
 * A --fast flag collapses all delays to 0 (useful for quick smoke tests).
 */

import { readFileSync } from "fs";
import { resolve } from "path";

interface DumpEntry {
  receivedAt: number;
  body: object;
}

const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith("--")));

const dumpPath = resolve(args[0] ?? "temp/gsi-dump.jsonl");
const target   = (args[1] ?? "http://localhost:3000").replace(/\/$/, "");
const fast     = flags.has("--fast");

const entries: DumpEntry[] = readFileSync(dumpPath, "utf8")
  .split("\n")
  .filter(l => l.trim())
  .map(l => JSON.parse(l) as DumpEntry);

if (entries.length === 0) {
  console.error("dump file is empty:", dumpPath);
  process.exit(1);
}

const totalMs = entries[entries.length - 1].receivedAt - entries[0].receivedAt;
console.log(`\n📼  Replaying ${entries.length} payloads from ${dumpPath}`);
console.log(`🎯  Target: ${target}`);
console.log(`⏱️   Original span: ${(totalMs / 1000).toFixed(1)}s${fast ? " → compressed to 0 (--fast)" : ""}\n`);

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function post(body: object, index: number): Promise<void> {
  const res = await fetch(`${target}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const status = res.status === 200 ? "✅" : `❌ ${res.status}`;
  console.log(`  [${String(index + 1).padStart(3)}/${entries.length}] ${status}`);
}

async function run(): Promise<void> {
  for (let i = 0; i < entries.length; i++) {
    if (i > 0) {
      const delay = fast ? 0 : entries[i].receivedAt - entries[i - 1].receivedAt;
      if (delay > 0) {
        process.stdout.write(`  ⏳ waiting ${delay}ms…\r`);
        await sleep(delay);
      }
    }
    await post(entries[i].body, i);
  }

  console.log(`\n✅  Replay complete (${entries.length} payloads sent)\n`);
}

run().catch(err => {
  console.error("replay failed:", err);
  process.exit(1);
});
