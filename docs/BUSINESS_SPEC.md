# Business & Product Specification: Real-Time AI Esports Post-Commentary

## 1. Executive Summary & Vision

The goal of this project is to produce automated, real-time **post-commentary** for Counter-Strike 2 matches — a delayed broadcast where the AI caster narrates what actually happened, with full knowledge of each segment, rather than guessing at incomplete data in flight.

By tapping into local live-match telemetry (Game State Integration) and running the broadcast on a deliberate **~20-second delay**, the system converts dry data points into high-energy, contextually accurate, audible human-like commentary. Each commentary line is a storyteller passage that builds naturally on the ones before it, covering exactly one ~3-second window of real game time.

The final product must emulate a Tier-1 professional esports broadcast (ESL or BLAST quality), turning amateur scrims, local FACEIT matches, or casual games into highly engaging entertainment experiences.

---

## 2. Core Value Proposition & Problem Statement

- **The Problem:** Live esports commentary currently requires human talent, making it impossible for casual players, amateur leagues, or solo streamers to have personalized, high-quality play-by-play casting. Naive AI attempts fail for two reasons: they either spam the listener with every raw event (bad pacing, no narrative arc) or they try to operate in real-time and suffer severe latency, rendering commentary irrelevant before it plays.
- **The Solution:** A **delayed-broadcast storyteller** that runs intentionally ~20 seconds behind the game. This allows the LLM to see each segment fully before narrating it, eliminates race conditions against API latency, produces clips that play back on the real broadcast timeline (true gaps between quiet windows), and maintains narrative continuity across every line via a rolling passage history fed back to the LLM.

---

## 3. Key Product Pillars & UX Guidelines

### A. The Hype Curve (Emotional Dynamics)

A human shoutcaster does not speak in a monotone drone. The AI caster must adapt pacing and energy to match the intensity of the moment:
- **Low Intensity (Buy phase / slow defaults):** Calm, analytical, focused on economy reads, positioning, weapon choices.
- **Medium Intensity (First blood / utility executes):** Elevated pacing, tracking map control and opening picks.
- **High Intensity (Site executes / retakes / multi-kills):** Breathless, explosive, high-velocity delivery.

### B. Silence as a Feature

Silence is a strategic asset. Empty game windows — where nothing of note happened — produce no batch and no clip. The Conductor play head simply advances through the gap. The audience hears natural dead air rather than synthetic filler, which builds tension and makes the next big call land harder.

### C. Narrative Continuity (The Story Rule)

Each LLM call is given the caster's recent passages. The LLM is instructed never to repeat a call it's already made, and to continue the broadcast as a single coherent narrative. The writing stage is **sequential** — only one LLM call runs at a time — so each passage is recorded in history before the next segment starts, guaranteeing a clean story chain with no race conditions.

### D. Information Accuracy (Delayed = Complete)

Because the system runs on delay, the LLM sees a sealed window of complete events rather than partial in-flight data. This eliminates hallucinated facts ("that was a double kill" when only one kill has fired yet) and produces more accurate, confident commentary.

---

## 4. Key Business Metrics & Operational Guardrails

### A. API Cost Optimization

The system batches events into short time windows. Only non-empty windows (those with at least one meaningful beat) produce an LLM + TTS call. In a typical 2-minute round with moderate action, this targets roughly **15–25 passages** — well within cost-efficient operating limits. Quiet freezetime periods produce at most one economy read, keeping token usage low during inactive phases.

### B. Broadcast Delay Target

The primary latency target is a realized broadcast delay of **20–25 seconds** behind real time. This is an intentional product decision — not a latency problem to solve — and it's what makes accurate post-commentary possible. The "elastic delay" design means the realized delay automatically stretches if the API is slow, always maintaining order, never dropping clips due to congestion.

### C. Coverage vs. Brevity

Each passage covers **one key beat** and stops (roughly a dozen spoken words). The most important event in the window — ranked by a priority order that puts match/round ends and bomb events above multi-kills, clutches, and ordinary kills, with ambient chatter last — is the headline. A second beat may be folded in only if it belongs in the same breath. Ambient chatter (scattered gunfire, partial flashes) is never the headline.

---

## 5. High-Level Functional Scope (MVP Boundaries)

| Feature | In Scope for MVP | Out of Scope for MVP |
| :--- | :--- | :--- |
| **Telemetry** | All players (full team coverage), round phases, bomb states, kill feed via state diff, economy, clutch detection. | Deep historical seasonal tracking, multi-match arcs. |
| **Commentary** | Delayed storyteller with rolling narrative continuity; passage history preventing repetition. | Real-time (zero-delay) casting, multi-language output. |
| **Vocal Styles** | Dynamic energy via TTS mode (`plain` or Gemini expressive `[tag]` + PERFORMANCE blocks). | Multiple interacting co-casters, custom cloned voice synthesis. |
| **Queueing** | Elastic broadcast delay, parallel TTS pool (4 concurrent renders), in-order Conductor play head. | Audio mixing, overlaying music tracks automatically under the voice. |
| **Recording** | Optional full broadcast capture to a single WAV with real timing gaps (`RECORD_BROADCAST`). | Cloud upload, clip sharing, highlight reels. |

---

## 6. Functional Architecture & Business Alignment

### A. The Production Line

A single commentary line travels through a fixed sequence of responsibilities. Each stage has one job and hands off to the next; the names below are *roles*, not modules.

1. **Capture** — receive the live game feed and keep an always-current picture of the match (score, alive counts, bomb state, player positions) so commentary is grounded in real facts and never hallucinates them. Raw player coordinates are translated into human map callouts ("opening up Long" rather than a coordinate pair).
2. **Interpret** — turn the raw feed into *beats*: the meaningful moments (kills, trades, clutches, bomb plays, economy reads) worth talking about. This stage owns the judgment — deduplication and cooldowns mean the caster never hears "player is firing" every second — and ranks beats so the headline of a busy moment leads.
3. **Segment** — group beats into short windows, one spoken line per window. Round and match boundaries force a clean break so a story segment never bleeds across rounds. **Empty windows produce nothing — silence is real.**
4. **Write (sequential)** — turn one segment into one short caster passage. This stage runs strictly one at a time so every passage can see the recent broadcast history, guaranteeing narrative continuity and no repeated calls.
5. **Voice (parallel)** — render passages to audio. Multiple renders run concurrently behind the single-file writing stage so throughput keeps up with the game.
6. **Air** — a play head broadcasts each clip at its scheduled moment, a fixed delay behind the live game, strictly in order. It waits if a render is late and plays immediately when a clip is already overdue; dense action plays back-to-back with no gap. A failed render is skipped without breaking the sequence. Aired audio can optionally be archived to a single recording with its real timing gaps intact.

### B. Key Architectural Invariants

- **Order is absolute:** The Conductor always airs clips in batch-index order. A fast render never jumps ahead of a slow one.
- **Silence is real:** Empty windows leave a real gap in the broadcast timeline, matching the pace of the actual game.
- **History prevents repetition:** The sequential text stage and rolling passage history ensure the AI never calls the same play twice.
- **Delay is elastic:** If TTS is slow, the realized delay stretches beyond 20s. It never shrinks below 20s unless every stage completes faster than the floor.
