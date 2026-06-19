import { execSync } from "child_process";
import fsSync from "fs";
import path from "path";

const IS_WSL =
  process.platform === "linux" &&
  !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);

function resolveTempDir(): string {
  if (IS_WSL) {
    try {
      const winTemp = execSync("cmd.exe /c echo %TEMP%", { encoding: "utf8" })
        .trim()
        .replace(/\r/g, "");
      return execSync(`wslpath -u '${winTemp}'`, { encoding: "utf8" }).trim();
    } catch {
      // Fall through to project-local temp.
    }
  }
  return path.resolve(process.cwd(), "temp");
}

/** Absolute path to the audio temp directory, created on first import. */
export const TEMP_DIR = resolveTempDir();
fsSync.mkdirSync(TEMP_DIR, { recursive: true });

export const IS_WSL_ENV = IS_WSL;

/**
 * Repo-local `./temp` directory for session artifacts — the GSI dump, the app
 * log, and broadcast recordings. Distinct from TEMP_DIR: those artifacts belong
 * with the project and should never clutter the repo root, whereas TEMP_DIR on
 * WSL points at Windows %TEMP% so PowerShell can play audio clips by a native path.
 */
export const ARTIFACT_DIR = path.resolve(process.cwd(), "temp");
fsSync.mkdirSync(ARTIFACT_DIR, { recursive: true });

/** Convert a Linux path to the Windows path PowerShell needs (WSL only). */
export function toWindowsPath(linuxPath: string): string {
  return execSync(`wslpath -w '${linuxPath}'`, { encoding: "utf8" }).trim();
}
