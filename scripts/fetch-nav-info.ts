// Downloads CS2 map callout/nav data (etc/nav-info/nav-info.csv) from awpy (MIT) instead of
// committing the ~3.8MB file into this repo. Pinned to a specific awpy commit and a hardcoded
// SHA-256 — upstream awpy 2.x dropped this precomputed file in favor of parsing raw .nav meshes,
// so this commit is the last known-good source and isn't expected to move.
//
// Runs automatically via the root "postinstall" script; safe to re-run manually with
// `npm run fetch:nav-info` (e.g. to retry after a network failure during install).
//
// See etc/nav-info/README.md and etc/nav-info/THIRD_PARTY_LICENSE.txt for attribution.
import { createHash } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

const NAV_INFO_URL =
  "https://raw.githubusercontent.com/pnxenopoulos/awpy/580eb172c7eda9ad45004f4533386eaf2ffe5f1c/awpy/data/nav/nav_info.csv";
const EXPECTED_SHA256 = "1eb37fc44a3bb8ab1508579b5a1f084f23400d9a19141d28eef955df6ec62e15";
const OUTPUT_PATH = path.resolve("etc/nav-info/nav-info.csv");

async function main() {
  if (existsSync(OUTPUT_PATH)) {
    return;
  }

  console.log("[nav-info] fetching CS2 callout data from awpy (MIT)...");

  let bytes: Buffer;
  try {
    const res = await fetch(NAV_INFO_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.warn(
      `[nav-info] download failed (${(err as Error).message}) — callouts will be disabled until this succeeds. Retry with "npm run fetch:nav-info".`,
    );
    return;
  }

  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== EXPECTED_SHA256) {
    console.error(
      `[nav-info] hash mismatch — expected ${EXPECTED_SHA256}, got ${actualSha256}. Refusing to write untrusted data; callouts will be disabled.`,
    );
    return;
  }

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, bytes);
  console.log(`[nav-info] saved to ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

main();
