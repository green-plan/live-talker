# Technical Specification: Delayed-Broadcast Storyteller Architecture

This document explains *how* the system works and *why* it is built this way — the
pipeline stages, the timing model, and the invariants that must hold. It deliberately
does **not** restate type definitions, file locations, or tuning constants; those live
in the code and are the source of truth:

- **Data models** — `src/types/game.ts` (match/player state) and `src/types/pipeline.ts` (beats, batches, clips, passages, and the `OrchestratorConfig` shape).
- **Injected configuration** — the default orchestrator tuning lives in `src/config.ts` and is injected at the composition root (`src/index.ts`).
- **Tuning constants** — at the top of the relevant module (e.g. beat thresholds in the CS2 beat detector, model slugs in the synthesizers).
- **Layout & layering rules** — `AGENTS.md`.

---

## 1. Pipeline Overview

The system is a one-way pipeline run a fixed delay behind real time:

> **Ingest → Interpret → Batch → Narrate → Voice → Air**

Each stage produces an artifact the next consumes (snapshot/event → beat → sealed
batch → passage → rendered clip → aired audio). The orchestrator drives the stages on
a fixed tick; the game-specific logic lives behind generic interfaces so the engine
itself knows nothing about CS2.

---

## 2. Ingest — match state & events

The HTTP listener accepts the game's state-integration feed and produces two things on
every packet:

- **A normalized match snapshot** — the current macro picture (map, phase, score, round,
  bomb state, per-player health/armor/economy/weapon/flags, alive counts, map callouts).
  This is kept as a single rolling value plus a short timestamped ring of recent
  snapshots, so any later stage can ask "what did the world look like N seconds ago?"
- **A log of discrete events** — bomb lifecycle, round/match end, MVP, etc., buffered for
  the interpreter to drain.

Raw player coordinates are resolved to human map callouts during normalization, so
everything downstream speaks in callouts, never coordinates.

**Key decision — combat is derived from state diffs, not kill events.** Standard CS2 GSI
over HTTP does *not* emit kill/hurt events (those only arrive via HLAE's MIRV path). All
combat signals (kills, deaths, trades, multi-kills, low-HP, flashes, fire) are therefore
inferred by diffing consecutive snapshots, not by listening for kill events. Only the
objective/flow events above come through the event channel.

---

## 3. Interpret — beats

A game-specific analyst converts raw state into **beats**: the meaningful narrative
moments. It walks consecutive snapshot pairs over a window, diffs them, and combines that
with the drained event log to emit a deduplicated, intensity-tagged stream.

It owns the editorial judgment that keeps the broadcast listenable:

- **Cooldowns** stop continuous states (a player firing, low on HP) from re-emitting every
  tick.
- **Aggregation** collapses noise — e.g. scattered gunfire becomes at most one occasional
  ambient beat rather than one per shot.
- **Context tagging** — kills are classified (entry / trade / multi-kill) and stamped with
  the exact alive count they left behind, so the writer can quote ground truth instead of
  recomputing it.
- **Priority** — beat types are ranked so a busy window's headline (match end, bomb event,
  multi-kill, clutch…) leads and ambient chatter never does.

The same analyst also produces a plain-English **tactical situation** summary (what the
current state *means* — bomb stakes, clutch odds, economy story). This is game knowledge,
so it lives here, not in the writing layer.

---

## 4. Batch — sealed segments

Beats are grouped into contiguous time windows, one spoken line per window.

- **Sealing** — a window seals once its end (plus a short grace for late beats) has fully
  elapsed, or immediately on a round/match boundary so segments never bleed across rounds.
- **Silence is real** — an empty window produces no batch. The downstream play head simply
  advances through the gap, preserving natural dead air.
- **Anchoring** — each sealed batch records the timestamp its action began; that anchor
  determines when its clip airs (`anchor + delay`).
- **Overflow** — pending batches are capped; under sustained downstream stall the oldest is
  dropped rather than growing unbounded.

---

## 5. Narrate & Voice — synthesis

Synthesis is split into two stages with deliberately different concurrency, behind generic
interfaces (`ICommentaryWriter`, `ISpeechSynthesizer`) so a game or provider can be swapped
without touching the orchestrator.

### Narrate (sequential)

One segment becomes one short caster passage via an LLM. The writer is given the segment's
beats, the current match state, the tactical summary, and the caster's recent passages.
Two outputs are produced: the spoken **transcript** (recorded in history) and the **speech
text** handed to TTS (which may carry voice-engine scaffolding).

This stage runs **strictly one at a time**. The story depends on continuity — each passage
must see the previous one to avoid repeating a call — so a passage is appended to history
before the next batch starts. Sequencing is enforced by an in-flight flag, not by a pool.

The CS2 caster persona, game vocabulary, and the rule set that keeps calls in beat-order and
forbids invented facts all live in the writer's prompts. `TTS_MODE` selects plain prose
(provider-agnostic) or an expressive format with inline tags for a TTS engine that supports
voice direction.

### Voice (parallel)

Passages render to audio concurrently behind the sequential writer, so throughput keeps up
with the game. A small worker pool bounds how many renders run at once; each finished clip
is filed by batch index for the play head.

---

## 6. Air — the conductor

A single play head airs clips, and it is where the **broadcast delay** is realized.

It advances a monotonic pointer through batch indexes — **always in order**:

1. If the next index hasn't rendered yet, **wait** and retry on the next tick.
2. If it failed to render, **skip** it and advance.
3. Otherwise compute its air time (`anchor + delay`); sleep until then if it's in the
   future, then play it (and optionally archive it).

### The delay is elastic

The delay is a floor, not a fixed offset. If the pipeline is fast, the head sleeps until
`anchor + delay`. If it's slow (API congestion), clips air later — the delay stretches — but
order is never violated and clips are never dropped to catch up. Dense sequences (multiple
kills in one window) play back-to-back with no gap, because the later clip's target has
already passed by the time the earlier one finishes.

This is the core product decision: a deliberate delay buys complete, ordered, accurate
commentary. It is not a latency bug to be optimized away.

### Playback is a swappable sink

"Play it" doesn't hardcode where the audio actually goes — desktop playback and a
browser-based overlay (for OBS, broadcasting to any number of connected viewers over
a control channel, with a manual pause that stops every further LLM/TTS call until
resumed) are interchangeable implementations of one playback seam, chosen at the
composition root. The conductor's own ordering/elastic-delay guarantees above hold
identically regardless of which one is active — a disconnected or slow playback
target degrades locally (a clip waits, then proceeds) rather than stalling the
broadcast.

### Pickup is deliberately deferred within the floor

A sealed batch isn't necessarily handed to the writing stage the instant it seals. How
backed up the broadcast is shapes word count and delivery pace, and that read is only
trustworthy once enough real time has passed for a true picture of incoming action to
form — sampled immediately at seal time, it can't yet see a burst that's only just
starting. So pickup borrows from whatever slack still exists before the batch's own air
deadline, waiting long enough for that picture to settle before committing the batch to
the writer — never so long that the deadline itself is put at risk. A clean narrative cut
(a round or match boundary) or the synthetic dead-air filler skips this entirely: there's
nothing further to wait for.

---

## 7. Configuration & timing

All timing and concurrency knobs live in one injected config object (its shape is
`OrchestratorConfig`; the default values are in `src/config.ts`): the conductor tick,
interpret window, batch window and seal grace, the broadcast delay floor, speech
concurrency, how much passage history is fed back, and the pending-batch cap. Treat that
object as the authoritative reference — this document intentionally does not duplicate the
values, so they can change without invalidating the spec.

The two architectural facts that *won't* change: the writing stage is effectively serial
(continuity), and the speech stage is pooled (throughput).

---

## 8. Expressive TTS formatting

When the expressive `TTS_MODE` is selected, the writer emits a structured script (a fixed
performance/voice block, a non-spoken context line, and the spoken transcript). Only the
spoken transcript is stored in passage history; the scaffolding is voice-engine direction
and is stripped before recording. See `docs/README-GEMINI-TTS.md` for the format details and
prompt-engineering notes.

---

## 9. Resilience

A single bad frame, failed API call, or unplayable clip must never take down the process.
Every external boundary (game feed parsing, LLM/TTS calls, file I/O, audio playback) is
wrapped so failures degrade locally — a dropped frame, a skipped clip — rather than crashing
the broadcast.
