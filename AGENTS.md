# Agent Guide: CS2 Live AI Shoutcaster

Orientation for working **in** this codebase. It covers the layering, conventions, and
invariants that aren't obvious from any single file. For *what the system does and why*,
read `docs/BUSINESS_SPEC.md` and `docs/TECHNICAL_SPEC.md`; for the file layout, read the
tree (`src/` is small and self-describing) — this guide deliberately doesn't mirror it.

## Environment

- **Runtime:** Node.js (pinned via `mise`); modern TypeScript (ESM) run directly with `tsx`.
- **Package manager:** `npm`. Dependencies are whatever `package.json` declares — don't
  maintain a separate list here.
- **Commands:** `npm run dev` (hot reload), `npm run build && npm start` (prod),
  `npm test` (vitest), `npm run replay` (offline replay from a GSI dump). Run without API
  keys via `MOCK=true`.

## Layering (the important part)

Code is organized by *layer*, and the dependency arrow points one way: orchestrator → game
& synthesis → infra. The engine never imports game-specific code; it only sees interfaces.

- **`game/`** — turning raw telemetry into beats and match state. Generic pieces sit at the
  top; CS2-specific logic lives under `game/cs2/`.
- **`synthesis/`** — turning beats into a spoken passage. The generic `contracts.ts` defines
  the seam (`ICommentaryWriter`, `ISpeechSynthesizer`); the CS2 caster brain (persona,
  vocabulary, prompts) lives under `synthesis/cs2/`.
- **`infra/`** — boundary adapters: anything that talks to the outside world (the game feed
  listener, the OpenRouter HTTP client, TTS, audio playback). Provider/OS-specific code
  belongs here and nowhere else.
- **`orchestrator/`** — the game-agnostic engine (batching, the synthesis stages, the
  conductor play head). Depends only on interfaces and pipeline types.
- **`types/`** — `game.ts` (match state) and `pipeline.ts` (beats, batches, clips, passages,
  and the single orchestrator config object).

### Conventions

- **`cs2/` subfolders mark game-specific code.** Anything inside one is free to know CS2
  rules; anything outside one must not. A second game would be added as a sibling
  implementation behind the same interfaces, not by editing the engine.
- **Name by role, not mechanism.** The commentary brain is the `CommentaryWriter`, not a
  "text synthesizer." Keep domain names business-relevant; technical names are fine in
  `infra/`.
- **`index.ts` is the only composition root.** It reads every env var, builds shared clients
  once, and injects them (real or mock). Components never read `process.env` themselves.
- **Code is the documentation.** Don't add filenames, type bodies, or constant values to the
  Markdown docs — point at the code instead, so a refactor doesn't strand the prose.
- **Keep the docs reasonably current.** When a change alters behavior, layering, or an
  invariant the docs describe, update the docs (README, this file, `docs/`) in the same
  change. Pitched right (concepts, not specifics), a routine refactor shouldn't need a doc
  edit at all — if it does, the doc was too low-level; raise its altitude rather than just
  patching the detail.

## Invariants to preserve

These are load-bearing; breaking one silently degrades the broadcast:

1. **Order is absolute.** Clips air in batch-index order; a fast render never jumps a slow
   one.
2. **The delay is an elastic floor.** Nothing airs before `anchor + delay`; under congestion
   the delay stretches rather than dropping or reordering clips.
3. **Silence is real.** Empty windows produce no batch and leave a genuine gap.
4. **Writing is sequential; voicing is parallel.** The LLM stage runs one at a time for
   story continuity (each passage recorded before the next starts); TTS renders concurrently.
5. **Combat comes from state diffs.** Standard CS2 GSI doesn't emit kill events — never
   assume a kill/hurt event channel for combat.
6. **Nothing crashes the process.** Wrap every external boundary (feed parsing, network, file
   I/O, playback); a single bad frame or failed call degrades locally.

## Reference docs

- `docs/README-GAMEPLAY.md` — how raw GSI telemetry maps to narrative beats.
- `docs/README-CS2-EVENTS.md` — csgogsi object structures.
- `docs/README-GEMINI-TTS.md` — expressive TTS script format and prompt notes.
