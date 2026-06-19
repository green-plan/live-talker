# live-talker

Real-time AI esports shoutcaster for Counter-Strike 2. Taps into live match telemetry via Game State Integration, interprets events into narrative beats, batches them into story segments, generates commentary with an LLM, renders it to speech, and plays it back with a deliberate **22-second broadcast delay** — so the system always has complete context before it speaks.

---

## Architecture

A one-way pipeline that turns live game telemetry into spoken commentary, running a fixed delay behind real time:

**Ingest → Interpret → Batch → Narrate → Voice → Air**

1. **Ingest** — a local HTTP listener receives the game's state-integration feed and normalizes each packet into a rolling match snapshot plus a log of discrete events.
2. **Interpret** — a game-specific analyst diffs consecutive snapshots and reads the event log to emit *beats*: meaningful moments (kills, trades, clutches, bomb plays, economy reads) tagged with an intensity. Deduplication and cooldowns keep the noise out.
3. **Batch** — beats are grouped into short, time-windowed segments. Empty windows produce nothing; silence is preserved as real dead air.
4. **Narrate** — each sealed segment becomes one short caster passage written by an LLM. This stage is *sequential*: every passage sees the caster's recent history, so the broadcast reads as one continuous story and never repeats a call.
5. **Voice** — passages render to speech in parallel, behind the sequential narration stage.
6. **Air** — a play head ("the conductor") airs each clip at its scheduled time, a fixed delay behind the live game, strictly in order — stretching the delay elastically if a render runs late rather than ever playing out of sequence.

The deliberate broadcast delay is the central idea: by the time the caster speaks, the segment has fully resolved, so commentary is accurate and complete instead of racing incomplete data.

The code is layered so the pipeline stays game-agnostic and the game knowledge is isolated:

- **`game/` and `synthesis/`** hold the brains. The CS2-specific pieces (state interpretation, caster persona and prompts) sit under `cs2/` subfolders behind generic interfaces — a second game is added alongside, not by rewriting the pipeline.
- **`infra/`** holds boundary adapters: anything that talks to the outside world (game feed, LLM/TTS HTTP, audio playback).
- **`orchestrator/`** is the game-agnostic engine driving batching, the synthesis stages, and the conductor.

See [`AGENTS.md`](AGENTS.md) for the layering rules and [`docs/`](docs/) for the design specs.

---

## Quick Start

### 1. Copy and fill `.env`
```bash
cp .env.example .env
```

For real LLM + TTS commentary, set `OPENROUTER_API_KEY`.  
To run without any API key, set `MOCK=true` (see below).

### 2. Install dependencies
```bash
npm install
```

### 3. Run

**Development (hot reload):**
```bash
npm run dev
```

**Production:**
```bash
npm run build
npm start
```

CS2 GSI listens on `PORT` (default `3000`). Health endpoint is on `PORT+1`.

---

## Mock / Debug Mode

Set `MOCK=true` to run the full pipeline without API keys:

```bash
MOCK=true npm run dev
```

- **Mock commentary** — returns a quick summary of the buffered events instead of calling the LLM (delay configurable via `MOCK_TEXT_DELAY_MS`).
- **Mock speech** — renders the text with the OS's built-in voice (Windows SAPI, no install needed) instead of the TTS API, then plays it through the normal audio path — so you still hear real audio (`MOCK_SPEECH_DELAY_MS`).

---

## CS2 Setup

CS2 must be configured to POST game state to `http://localhost:3000`. Generate the config file:

```typescript
import { GSIConfigWriter } from 'cs2-gsi-z';
GSIConfigWriter.generate({ name: 'live-talker', uri: 'http://localhost:3000' });
```

Move the generated `.cfg` file to your CS2 `cfg/` directory and restart CS2.

---

## WSL Note

Audio playback on WSL2 routes through the Windows audio stack via `powershell.exe`. Audio files are written to the Windows `%TEMP%` directory so PowerShell can open them with a normal `C:\` path. No extra setup needed — this is handled automatically when `WSL_DISTRO_NAME` is set in the environment.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | GSI listener port; health runs on `PORT+1` |
| `OPENROUTER_API_KEY` | — | Required for real LLM + TTS |
| `MOCK` | `false` | Enable both mock synthesizers (no API key needed) |
| `MOCK_TEXT` | `false` | Mock LLM only |
| `MOCK_SPEECH` | `false` | Mock TTS only (uses Windows SAPI) |
| `MOCK_TEXT_DELAY_MS` | `900` | Simulated LLM latency in mock mode |
| `MOCK_SPEECH_DELAY_MS` | `900` | Simulated TTS latency in mock mode |
| `TTS_MODE` | `plain` | `plain` or `gemini` (expressive inline tags) |
| `LOG_LEVEL` | `info` | `trace` / `debug` / `info` / `warn` / `error` |
| `RECORD_BROADCAST` | — | `true` or a file path to capture a full-session WAV |
