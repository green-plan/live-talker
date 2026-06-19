// Quick TTS test: send a line of text through OpenRouter's Gemini TTS endpoint,
// formatted as a hype tournament-trailer commercial per the 3-part PERFORMANCE /
// CONTEXT / TRANSCRIPT architecture in docs/README-GEMINI-TTS.md, using the same
// model/voice as src/infra/SpeechSynthesizer.ts.
//
// Usage:
//   npm run tts -- "the bomb is down, CTs scrambling to retake A"
//   npm run tts -- "..." out.wav
import "dotenv/config";
import fs from "fs/promises";
import path from "path";

const ENDPOINT = "https://openrouter.ai/api/v1/audio/speech";
const MODEL = "google/gemini-3.1-flash-tts-preview";
const VOICE = "Fenrir";

// Per docs/README-GEMINI-TTS.md: never use "quiet/flat/monotone/no rush" in
// PERFORMANCE — it collapses the model into a flat AI-voice default.
const PERFORMANCE_BLOCK = `### PERFORMANCE
Voice: Fenrir
Style: Larger-than-life hype commercial voiceover — like the trailer announcer for a major esports tournament. Relentless forward momentum, booming confidence, every line landing like a trailer beat building to a crescendo.
Accent: British English with a crisp London broadcast accent.
Pacing: Punchy, fast, and explosive, with sharp accelerations into the biggest moments. Always full of feeling, never flat or restrained.`;

const CONTEXT_BLOCK = `### CONTEXT
A blockbuster hype commercial for a major esports tournament — booming arena energy, stadium lights blazing, the crowd roaring, building toward a massive crescendo.`;

// Wraps raw prompt text into a tagged, trailer-style TRANSCRIPT: opens hot,
// leans on ellipses for trailer-beat pauses, and punches out the close.
function buildTranscript(prompt: string): string {
  const trimmed = prompt.trim().replace(/[.\s]+$/, "");
  return `#### TRANSCRIPT
[excitedly] , ${trimmed} ... [shouting] , THIS is the moment!`;
}

function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bitDepth = 16): Buffer {
  const byteRate = (sampleRate * channels * bitDepth) / 8;
  const blockAlign = (channels * bitDepth) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function main() {
  const [prompt, outArg] = process.argv.slice(2);
  if (!prompt) {
    console.error('usage: npm run tts -- "<text to speak>" [out.wav]');
    process.exit(1);
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY not set (check .env)");
    process.exit(1);
  }

  const outPath = outArg ?? path.join("temp", `tts-${Date.now()}.wav`);
  const input = `${PERFORMANCE_BLOCK}\n\n${CONTEXT_BLOCK}\n\n${buildTranscript(prompt)}`;

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      input,
      voice: VOICE,
      response_format: "pcm",
    }),
  });

  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }

  const pcm = Buffer.from(await res.arrayBuffer());
  if (pcm.length === 0) {
    console.error("got 200 but an empty audio body — the API silently declined this input");
    process.exit(1);
  }

  const wav = pcmToWav(pcm);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, wav);
  console.log(`wrote ${outPath} (${wav.length} bytes)`);
}

main();
