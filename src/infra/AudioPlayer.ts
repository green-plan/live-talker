import fsSync from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import path from "path";
import sound from "sound-play";
import { TEMP_DIR, IS_WSL_ENV, toWindowsPath } from "../utils/tempDir.js";
import { logger } from "../utils/logger.js";

const log = logger.child({ service: "[AudioPlayer]" });
const execAsync = promisify(exec);

async function playFileWsl(filePath: string): Promise<void> {
  const winAudioPath = toWindowsPath(filePath);
  const ps1LinuxPath = path.join(TEMP_DIR, `shout_play_${randomUUID()}.ps1`);
  const winPs1Path = toWindowsPath(ps1LinuxPath);

  const ps1Content = [
    "Add-Type -AssemblyName presentationCore",
    "$player = New-Object system.windows.media.mediaplayer",
    `$player.open('${winAudioPath}')`,
    "$player.Volume = 1",
    "$player.Play()",
    // Poll for the clip duration to load (usually <200ms) instead of always
    // waiting a fixed second — that fixed second was inflating perceived latency.
    "$waited = 0",
    "while (-not $player.NaturalDuration.HasTimeSpan -and $waited -lt 1000) { Start-Sleep -Milliseconds 50; $waited += 50 }",
    "if ($player.NaturalDuration.HasTimeSpan) { Start-Sleep -s $player.NaturalDuration.TimeSpan.TotalSeconds } else { Start-Sleep 2 }",
  ].join("\n");

  fsSync.writeFileSync(ps1LinuxPath, ps1Content, "utf8");
  try {
    await execAsync(
      `powershell.exe -ExecutionPolicy Bypass -File "${winPs1Path}"`
    );
  } finally {
    try {
      fsSync.unlinkSync(ps1LinuxPath);
    } catch {
      // already gone
    }
  }
}

/**
 * AudioPlayer — "The Speaker".
 *
 * Pure playback primitive. Queue management and expiry logic live in the
 * Shoutcast orchestrator.
 */
export class AudioPlayer {
  public isPlaying: boolean = false;

  async play(filePath: string): Promise<void> {
    log.debug({ filePath }, "playback start");
    this.isPlaying = true;
    const t0 = Date.now();
    try {
      if (IS_WSL_ENV) {
        await playFileWsl(filePath);
      } else {
        await sound.play(filePath);
      }
      log.debug({ filePath, durationMs: Date.now() - t0 }, "playback done");
    } catch (err) {
      log.error({ err, filePath }, "playback error");
    } finally {
      this.isPlaying = false;
    }
  }
}
