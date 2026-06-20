<p align="center">
  <img src="docs/images/livetalker.png" alt="live—talker: a tiny AI broadcast crew" width="600">
</p>

<p align="center">
  <a href="https://green-plan.github.io/live-talker/">🔗 Homepage</a>
</p>

> ⚠️ **Early, experimental proof of concept** — not a product, just a hobby project shared
> as-is. Expect rough edges and breaking changes.
>
> ⚠️ **An API key is optional** — the app runs without one in [Mock / Debug
> Mode](#mock--debug-mode). Configuring a real key to use paid LLM/TTS APIs is your choice,
> and this code can have bugs that cause unintended, excessive, or looping calls. If you use
> a real key, put a hard spend limit on it and monitor the running process — you are entirely
> responsible for any charges incurred, including from bugs in this code. Use solely at your own
> risk. See [`DISCLAIMER.md`](DISCLAIMER.md).

Real-time AI esports shoutcaster for Counter-Strike 2. Taps into live match telemetry via Game State Integration, interprets events into narrative beats, batches them into story segments, generates commentary with an LLM, renders it to speech, and plays it back on a deliberate, configurable **broadcast delay** — so the system always has complete context before it speaks.

---

## Table of Contents

- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [Running](#running)
  - [Development](#development)
  - [Production](#production)
  - [Mock / Debug Mode](#mock--debug-mode)
- [CS2 Setup](#cs2-setup)
- [Broadcasting with OBS](#broadcasting-with-obs)
  - [Isolated audio via the browser overlay](#isolated-audio-via-the-browser-overlay)
  - [Syncing the video delay](#syncing-the-video-delay)
  - [Recording game and overlay as separate tracks](#recording-game-and-overlay-as-separate-tracks)
- [Platform Notes](#platform-notes)
- [Environment Variables](#environment-variables)
- [Acknowledgments](#acknowledgments)

---

## Architecture

A one-way pipeline that turns live game telemetry into spoken commentary, running a fixed delay behind real time:

**Ingest → Interpret → Batch → Narrate → Voice → Air**

<p align="center">
  <img src="docs/images/full_crew.png" alt="The full crew: Listener, Memory, Map Reader, Analyst, Storyteller, Voice, Archivist, Conductor" width="700">
</p>

1. **Ingest** — a local HTTP listener receives the game's state-integration feed and normalizes each packet into a rolling match snapshot plus a log of discrete events.
2. **Interpret** — a game-specific analyst diffs consecutive snapshots and reads the event log to emit *beats*: meaningful moments (kills, trades, clutches, bomb plays, economy reads) tagged with an intensity. Deduplication and cooldowns keep the noise out.
3. **Batch** — beats are grouped into short, time-windowed segments. Empty windows produce nothing; silence is preserved as real dead air.
4. **Narrate** — each sealed segment becomes one short caster passage written by an LLM. This stage is *sequential*: every passage sees the caster's recent history, so the broadcast is intended to read as one continuous story without repeating a call.
5. **Voice** — passages render to speech in parallel, behind the sequential narration stage.
6. **Air** — a play head ("the conductor") airs each clip at its scheduled time, a fixed delay behind the live game, strictly in order — stretching the delay elastically if a render runs late rather than ever playing out of sequence. Where the audio actually goes (desktop, or an isolated [OBS overlay](#isolated-audio-via-the-browser-overlay)) is a swappable last step, not baked into the conductor.

The deliberate broadcast delay is the central idea: by the time the caster speaks, the segment has fully resolved, so commentary is based on complete data instead of racing incomplete data.

<p align="center">
  <img src="docs/images/lag.png" alt="Commentary runs a few seconds behind the live match" width="600">
</p>

The code is layered so the pipeline stays game-agnostic and the game knowledge is isolated:

- **`game/` and `synthesis/`** hold the brains. The CS2-specific pieces (state interpretation, caster persona and prompts) sit under `cs2/` subfolders behind generic interfaces — a second game is added alongside, not by rewriting the pipeline.
- **`infra/`** holds boundary adapters: anything that talks to the outside world (game feed, LLM/TTS HTTP, audio playback).
- **`orchestrator/`** is the game-agnostic engine driving batching, the synthesis stages, and the conductor.
- **`overlay/`** and **`homepage/`** are independent frontend subprojects (own `package.json`/lockfile, not npm workspace members) — see their own READMEs.

See [`AGENTS.md`](AGENTS.md) for the layering rules and [`docs/`](docs/) for the design specs.

---

## Getting Started

**Requirements:** Node.js 24 (pinned via `mise` — see `mise.toml`), npm.

1. **Configure.** Copy the env template and fill in what you need:
   ```bash
   cp .env.example .env
   ```
   For real LLM + TTS commentary, set `OPENROUTER_API_KEY`. To skip that entirely and run
   without any API key, see [Mock / Debug Mode](#mock--debug-mode). The full list of
   variables (including ones below for the overlay/OBS setup) is in
   [Environment Variables](#environment-variables).

   Use a key with a hard spend limit you've set yourself — this project has not been audited
   for bugs that could trigger unintended or runaway API calls (e.g. a stuck loop), and you
   are solely responsible for any resulting cost. The LLM (`OPENROUTER_LLM_MODEL`) and TTS
   (`OPENROUTER_TTS_MODEL`) models are independently configurable and priced separately by
   the provider — check current pricing for whichever model you use, including the defaults.

2. **Install.** The [browser overlay](#isolated-audio-via-the-browser-overlay) is on by
   default, so its dependencies install alongside the backend's:
   ```bash
   npm install
   cd overlay && npm install && cd ..
   ```
   If you only want desktop audio and don't plan to use OBS at all, you can skip the
   `overlay/` install and use the desktop-only commands below instead.

---

## Running

CS2 GSI listens on `PORT` (default `3000`). Health endpoint is on `PORT+1`. The overlay
listens on `OVERLAY_PORT` (default `PORT+2`) — see [Broadcasting with OBS](#broadcasting-with-obs).

### Development

| Scenario | Command |
|---|---|
| Overlay playback (default) | `npm run dev` — builds `overlay/` then starts the backend |
| Desktop-only playback | `npm run dev:desktop` — skips the overlay build, sets `OVERLAY=false` |

Both use `tsx --watch` for hot reload.

### Production

| Scenario | Commands |
|---|---|
| Overlay playback (default) | `npm run build` → `npm start` |
| Desktop-only playback | `npm run build` → `npm run start:desktop` |

### Mock / Debug Mode

Set `MOCK=true` to run the full pipeline without API keys (works with any of the commands above,
e.g. `MOCK=true npm run dev` or `MOCK=true npm run dev:desktop`):

- **Mock commentary** — returns a quick summary of the buffered events instead of calling the LLM (delay configurable via `MOCK_TEXT_DELAY_MS`).
- **Mock speech** — renders the text with the OS's built-in voice (Windows SAPI, no install needed) instead of the TTS API, then plays it through the normal audio path — so you still hear real audio (`MOCK_SPEECH_DELAY_MS`).

---

## CS2 Setup

CS2 must be configured to POST game state to the backend's GSI listener
(`http://localhost:3000` by default — match this to your `PORT` if you've changed it).

Create a file named `gamestate_integration_local.cfg` in CS2's `csgo/cfg/` directory — e.g.
on Windows:

```
<steam dir>\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg\gamestate_integration_local.cfg
```

with the following contents:

```
"Shoutcaster Broadcast Integration"
{
  "uri"          "http://localhost:3000"
  "timeout"      "3.0"
  "buffer"       "0.0"
  "throttle"     "0.0"
  "heartbeat"    "30.0"
  "data"
  {
    "provider"                  "1"
    "map"                       "1"
    "map_round_wins"            "1"
    "round"                     "1"
    "phase_countdowns"          "1"
    "allplayers_id"             "1"
    "allplayers_state"          "1"
    "allplayers_match_stats"    "1"
    "allplayers_weapons"        "1"
    "allplayers_position"       "1"
    "allgrenades"               "1"
    "bomb"                      "1"
  }
}
```

Restart CS2 (or rejoin a match) for it to pick up the new config. CS2 only POSTs while a
match is active — you won't see traffic in main menu/spectator-free states.

The analyst (`game/cs2/`) currently drives its beats from `map`, `round`, `bomb`,
`allplayers_position`, `allplayers_weapons`, and `allplayers_state`/`allplayers_id`; the
other blocks above are harmless to leave enabled (forward-compatible with beats that read
them later) but aren't required for current behavior.

---

## Broadcasting with OBS

### Isolated audio via the browser overlay

Commentary plays through the **browser overlay** by default — a small page that OBS adds as
a Browser Source, which plays each clip through its own `<audio>` element and renders a live
waveform plus a timestamped history of what's been said. It also exposes a **pause
shoutcasting** button that stops the LLM/TTS pipeline backend-wide (no API calls, no tokens spent)
without losing warm match state, for whenever the process is running but nobody's live. This
keeps commentary as its own isolated audio track, separate from desktop output — useful even
outside OBS, e.g. monitoring in a plain browser tab. For quick local testing without a browser
involved, set `OVERLAY=false` to fall back to desktop audio (see [Running](#running)).

<p align="center">
  <img src="docs/images/overlay.png" alt="The browser overlay: live waveform, current line, and a timestamped shoutcast history" width="420">
</p>

1. Start the backend — overlay is on by default, see [Running](#running) (`npm run dev` or the
   production `build`/`start` pair).
2. In OBS, add a **Browser Source** pointed at `http://localhost:3002/` (or your `OVERLAY_PORT`).
3. Check **Control audio via OBS** on that source — this captures the page's audio as its own
   isolated track, completely separate from desktop output.

The page also works in a plain browser tab for monitoring — any number of tabs/OBS sources can be
connected at once, each with its own mute toggle.

### Syncing the video delay

The caster's commentary lags the live action on purpose (see [Architecture](#architecture)), so
OBS needs to hold the *raw game feed* — video and its own audio — back by the same amount, on the
**game source specifically** (not a global **Stream Delay**, which would shift the game feed and
the already-correctly-timed commentary together and fix nothing).

- **Video** — add a **Render Delay** filter to the game capture source. OBS caps it at 500ms per
  instance, so matching the broadcast delay (`delayMs` in `src/config.ts`, 10s by default) means
  stacking `ceil(delayMs / 500)` instances — 20 for the default. Recompute if you change `delayMs`.
- **The game's own audio** (gunfire, voice chat) — set **Sync Offset (ms)** to `delayMs` in that
  source's Advanced Audio Properties. No stacking needed; this field isn't capped.
- **The commentary and overlay audio** — no added delay. Both already air at `anchor + delayMs`
  straight out of the pipeline, so they're already in sync with the now-delayed game feed.

### Recording game and overlay as separate tracks

If you're recording rather than streaming live, give the game's video+audio and the overlay's
audio different track numbers (Advanced Audio Properties → **Tracks**), then pick which tracks get
muxed into the output file under **Settings → Output → Recording**. That keeps them independently
adjustable afterward instead of needing a re-record. The overlay's visual widget is only the
Browser Source's *picture* and is independent of its audio — hide that source's eye icon if you
want its sound captured without compositing its visual into the frame.

---

## Platform Notes

**WSL2** — audio playback (desktop mode, not the overlay) routes through the Windows audio stack
via `powershell.exe`. Audio files are written to the Windows `%TEMP%` directory so PowerShell can
open them with a normal `C:\` path. No extra setup needed — this is handled automatically when
`WSL_DISTRO_NAME` is set in the environment.

---

## Environment Variables

| Variable | Default  | Description                                                                                                                                                                |
|---|----------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `PORT` | `3000`   | GSI listener port; health runs on `PORT+1`                                                                                                                                 |
| `OPENROUTER_API_KEY` | —        | Optional; needed only for real LLM + TTS (Costs and key limits are your responsibility. Omit and use `MOCK` below for no API key/cost)                                     |
| `MOCK` | `false`  | Enable both mock synthesizers (no API key needed)                                                                                                                          |
| `MOCK_TEXT` | `false`  | Mock LLM only                                                                                                                                                              |
| `MOCK_SPEECH` | `false`  | Mock TTS only (uses Windows SAPI)                                                                                                                                          |
| `MOCK_TEXT_DELAY_MS` | `900`    | Simulated LLM latency in mock mode                                                                                                                                         |
| `MOCK_SPEECH_DELAY_MS` | `900`    | Simulated TTS latency in mock mode                                                                                                                                         |
| `TTS_MODE` | `plain`  | `plain` or `gemini` (expressive inline tags)                                                                                                                               |
| `LOG_LEVEL` | `info`   | `trace` / `debug` / `info` / `warn` / `error`                                                                                                                              |
| `RECORD_BROADCAST` | `false`  | `true` to record the full session to `temp/broadcast-<timestamp>.wav` (with a matching `.srt` subtitle track alongside it), or a file path to choose the location yourself |
| `OVERLAY` | `true`   | Air audio through the [browser overlay](#isolated-audio-via-the-browser-overlay) (for OBS) instead of desktop playback; set to `false` for desktop-only playback           |
| `OVERLAY_PORT` | `PORT+2` | Port for the overlay's HTTP + WebSocket server                                                                                                                             |
| `OPENROUTER_MAX_CALLS_PER_SESSION` | `2000`   | Hard ceiling on total OpenRouter calls per process lifetime — a backstop attempt against a bug causing unbounded calls, not a cost budget                                  |
| `OPENROUTER_RATE_LIMIT_PER_MINUTE` | `60`     | Max OpenRouter calls allowed in any trailing 60s window (doesn't block concurrent text+speech calls under the limit)                                                       |
| `OPENROUTER_LLM_MODEL` | `google/gemini-3.5-flash` | OpenRouter model slug for commentary text. Pricing varies by model — check OpenRouter's current pricing before overriding |
| `OPENROUTER_TTS_MODEL` | `google/gemini-3.1-flash-tts-preview` | OpenRouter model slug for speech synthesis. Pricing varies by model — check OpenRouter's current pricing before overriding |

---

## Acknowledgments

Map callout/navigation data (`etc/nav-info/`) comes from [awpy](https://github.com/pnxenopoulos/awpy)
(MIT) — see [`etc/nav-info/THIRD_PARTY_LICENSE.txt`](etc/nav-info/THIRD_PARTY_LICENSE.txt). GSI event
structures are documented from [csgogsi](https://github.com/osztenkurden/csgogsi) (MIT) — see
[`docs/README-CS2-EVENTS.md`](docs/README-CS2-EVENTS.md) for its embedded README and license. The
homepage's full third-party dependency list is generated at build time into
`third-party-licenses.txt`, linked from its footer.
