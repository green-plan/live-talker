import dotenv from "dotenv";
dotenv.config();

import path from "path";
import express from "express";
import { logger } from "./utils/logger.js";
import { BroadcastRecorder } from "./audio/BroadcastRecorder.js";
import { BeatDebugRecorder } from "./audio/BeatDebugRecorder.js";
import { GameEventBuffer } from "./game/GameEventBuffer.js";
import { NavMap } from "./game/cs2/NavMap.js";
import { CentralState } from "./game/cs2/CentralState.js";
import { BeatDetector } from "./game/cs2/BeatDetector.js";
import { OpenRouterClient } from "./infra/OpenRouterClient.js";
import { CommentaryWriter, type TtsMode } from "./synthesis/cs2/CommentaryWriter.js";
import { SpeechSynthesizer } from "./infra/SpeechSynthesizer.js";
import { MockCommentaryWriter } from "./synthesis/MockCommentaryWriter.js";
import { MockSpeechSynthesizer } from "./infra/MockSpeechSynthesizer.js";
import { AudioPlayer } from "./infra/AudioPlayer.js";
import { startGsiService } from "./infra/cs2/GsiListener.js";
import { ShoutCaster } from "./orchestrator/ShoutCaster.js";
import { DEFAULT_ORCHESTRATOR_CONFIG } from "./config.js";
import { ARTIFACT_DIR } from "./utils/tempDir.js";

const log = logger.child({ service: "[index]" });

const PORT = Number(process.env.PORT ?? 3000);
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MOCK_TEXT = process.env.MOCK_TEXT === "true" || process.env.MOCK === "true";
const MOCK_SPEECH = process.env.MOCK_SPEECH === "true" || process.env.MOCK === "true";
const TTS_MODE = (process.env.TTS_MODE === "gemini" ? "gemini" : "plain") as TtsMode;
const MOCK_TEXT_DELAY = Number(process.env.MOCK_TEXT_DELAY_MS ?? 900);
const MOCK_SPEECH_DELAY = Number(process.env.MOCK_SPEECH_DELAY_MS ?? 900);
// RECORD_BROADCAST=true → save the whole session as one WAV with real timing;
// or set it to an explicit output path.
const RECORD_BROADCAST = process.env.RECORD_BROADCAST;

if (MOCK_TEXT) log.info("MOCK_TEXT — using mock LLM, no API key required for text synthesis");
if (MOCK_SPEECH) log.info("MOCK_SPEECH — using mock TTS (Windows SAPI), no API key required for speech");
if (!MOCK_TEXT && !OPENROUTER_API_KEY) log.warn("OPENROUTER_API_KEY not set — text synthesis will be skipped");
if (!MOCK_SPEECH && !OPENROUTER_API_KEY) log.warn("OPENROUTER_API_KEY not set — speech synthesis will be skipped");
log.info({ ttsMode: TTS_MODE }, "TTS script mode");

// One shared HTTP client for all OpenRouter calls — synthesizers receive the
// abstraction, not the raw credential.
const orClient = OPENROUTER_API_KEY ? new OpenRouterClient(OPENROUTER_API_KEY) : undefined;

// --- Core components --------------------------------------------------------
const eventBuffer = new GameEventBuffer(1000);
const navMap = new NavMap();
const centralState = new CentralState(navMap);
const interpreter = new BeatDetector();
const audioPlayer = new AudioPlayer();

const textSynth = MOCK_TEXT
  ? new MockCommentaryWriter(MOCK_TEXT_DELAY)
  : new CommentaryWriter(orClient, TTS_MODE);

const speechSynth = MOCK_SPEECH
  ? new MockSpeechSynthesizer(MOCK_SPEECH_DELAY)
  : new SpeechSynthesizer(orClient);

// Filesystem-safe, human-readable local timestamp, e.g. "2026-06-18_13-52-00".
const sessionStamp = new Date().toLocaleString("sv-SE").replace(/[: ]/g, (m) => (m === " " ? "_" : "-"));

const broadcastPath = RECORD_BROADCAST
  ? (RECORD_BROADCAST === "true"
      ? path.join(ARTIFACT_DIR, `broadcast-${sessionStamp}.wav`)
      : RECORD_BROADCAST)
  : undefined;
const recorder = broadcastPath ? new BroadcastRecorder(broadcastPath) : undefined;
// Piggyback on RECORD_BROADCAST — a debug beats SRT alongside the full recording,
// showing every beat's fate (SENT to the LLM / SKIPPED as ambient noise /
// EVICTED under backlog), for diagnosing beats that never get commented on.
const beatDebugRecorder = broadcastPath
  ? new BeatDebugRecorder(broadcastPath.replace(/\.wav$/i, "") + ".beats.srt")
  : undefined;
if (recorder) log.info("RECORD_BROADCAST — saving the full broadcast (with real timing) to a WAV, plus a debug beats SRT");

// --- Orchestrator -----------------------------------------------------------
const shoutCaster = new ShoutCaster(
  DEFAULT_ORCHESTRATOR_CONFIG,
  eventBuffer,
  centralState,
  interpreter,
  textSynth,
  speechSynth,
  audioPlayer,
  recorder,
  beatDebugRecorder
);
shoutCaster.start();

// Finalize the recording (and the rest) on a clean shutdown.
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await shoutCaster.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- GSI ingestion ----------------------------------------------------------
startGsiService(
  PORT,
  (data) => centralState.applyData(data),
  (id, eventName, data, playerName) => {
    eventBuffer.addEvent({
      id,
      event: eventName,
      ...(playerName ? { playerName } : {}),
      data,
      timestamp: Date.now(),
    });
  }
);

// --- Health endpoint --------------------------------------------------------
const HEALTH_PORT = PORT + 1;
const app = express();
app.get("/health", (_req, res) => res.json({ ok: true, mockText: MOCK_TEXT, mockSpeech: MOCK_SPEECH, ttsMode: TTS_MODE }));
app.listen(HEALTH_PORT, () =>
  log.info({ port: HEALTH_PORT }, `health endpoint on ${HEALTH_PORT}`)
);

log.info({ gsiPort: PORT, healthPort: HEALTH_PORT, mockText: MOCK_TEXT, mockSpeech: MOCK_SPEECH }, "shoutcaster online");
