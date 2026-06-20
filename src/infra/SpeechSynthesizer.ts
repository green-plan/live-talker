import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { TEMP_DIR } from "../utils/tempDir.js";
import { wrapPcm } from "../utils/wav.js";
import type { ISpeechSynthesizer } from "../synthesis/contracts.js";
import type { OpenRouterClient } from "./OpenRouterClient.js";
import { logger } from "../utils/logger.js";

const log = logger.child({ service: "[SpeechSynthesizer]" });

// Default OpenRouter TTS model slug — overridable via OPENROUTER_TTS_MODEL (see index.ts).
const DEFAULT_MODEL = "google/gemini-3.1-flash-tts-preview";

export class SpeechSynthesizer implements ISpeechSynthesizer {
  constructor(
    private readonly client?: OpenRouterClient,
    private readonly model: string = DEFAULT_MODEL,
  ) {}

  async synthesizeToFile(text: string): Promise<string | null> {
    if (!this.client) return null;
    if (!text) return null;

    const filePath = path.join(TEMP_DIR, `shout-${randomUUID()}.wav`);

    log.debug(
      { chars: text.length, text: text.slice(0, 200) + (text.length > 200 ? "…" : "") },
      "sending to speech synthesis"
    );

    const t0 = Date.now();

    try {
      const pcm = await this.client.postBinary("/audio/speech", {
        model: this.model,
        input: text,
        voice: "Fenrir",
        response_format: "pcm",
      });
      const wav = wrapPcm(pcm);
      await fs.writeFile(filePath, wav);
      log.info(
        { latencyMs: Date.now() - t0, pcmBytes: pcm.length, wavBytes: wav.length, filePath },
        `wav written (${wav.length} bytes)`
      );
      return filePath;
    } catch (err) {
      log.error({ err, latencyMs: Date.now() - t0 }, "synthesis failed");
      return null;
    }
  }
}
