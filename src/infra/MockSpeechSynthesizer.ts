import fsSync from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import { randomUUID } from "crypto";
import { TEMP_DIR, IS_WSL_ENV, toWindowsPath } from "../utils/tempDir.js";
import type { ISpeechSynthesizer } from "../synthesis/contracts.js";
import { logger } from "../utils/logger.js";

const log = logger.child({ service: "[MockSpeechSynthesizer]" });
const execAsync = promisify(exec);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function synthesizeViaWindowsSapi(text: string): Promise<string | null> {
  const wavLinuxPath = path.join(TEMP_DIR, `shout-mock-${randomUUID()}.wav`);
  const winWavPath = toWindowsPath(wavLinuxPath);
  const safeText = text.replace(/'/g, "''");

  const ps1Content = [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    `$s.SetOutputToWaveFile('${winWavPath}')`,
    `$s.Speak('${safeText}')`,
    "$s.SetOutputToDefaultAudioDevice()",
  ].join("\n");

  const ps1LinuxPath = path.join(TEMP_DIR, `shout_sapi_${randomUUID()}.ps1`);
  const winPs1Path = toWindowsPath(ps1LinuxPath);

  fsSync.writeFileSync(ps1LinuxPath, ps1Content, "utf8");
  const t0 = Date.now();
  try {
    await execAsync(
      `powershell.exe -ExecutionPolicy Bypass -File "${winPs1Path}"`
    );
    log.info({ filePath: wavLinuxPath, latencyMs: Date.now() - t0 }, "SAPI wav written");
    return wavLinuxPath;
  } catch (err) {
    log.error({ err }, "SAPI synthesis failed");
    return null;
  } finally {
    try {
      fsSync.unlinkSync(ps1LinuxPath);
    } catch {
      // already gone
    }
  }
}

export class MockSpeechSynthesizer implements ISpeechSynthesizer {
  private readonly delayMs: number;

  constructor(delayMs: number) {
    this.delayMs = delayMs;
  }

  async synthesizeToFile(text: string): Promise<string | null> {
    await sleep(this.delayMs);
    log.info({ delayMs: this.delayMs }, `synthesizing via SAPI: "${text.slice(0, 80)}"`);

    if (IS_WSL_ENV) {
      return synthesizeViaWindowsSapi(text);
    }

    log.warn("non-WSL environment — no mock audio output");
    return null;
  }
}
