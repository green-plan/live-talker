```markdown
# Gemini 3.1 Flash TTS: Comprehensive Text-Steering & Prompt Engineering Manual

This document is a comprehensive structural reference for prompting Google's generative text-to-speech (TTS) models (specifically `gemini-3.1-flash-tts-preview`). 

Unlike legacy systems that rely on rigid XML or SSML formatting, Gemini treats script architecture, behavioral headers, and bracketed text annotations as direct semantic instructions. Use this document to instruct your LLM pipeline to format spoken text exactly as required by the Gemini audio engine.

---

## 1. The Core 3-Part Script Architecture

Gemini TTS requires text inputs to follow a strict structural hierarchy. If you provide raw prose, the model will often become confused, read directional text aloud, or fail to apply emotional nuances. 

Every generated output must map exactly to this three-part layout:

```text
### PERFORMANCE
[Global vocal delivery instructions go here. Define the speaker's overarching style, specific regional accent parameters, baseline pacing traits, and overall conversational identity.]

### CONTEXT
[Detailed sensory and situational world-building. Describe the physical environment, crowd acoustics, or emotional tension of the scene. This helps the engine maintain consistent baseline expression.]

#### TRANSCRIPT
[The spoken text script. This section contains exclusively the character names, spoken lines, and inline tags. No metadata or instructions may look like plain text here.]

```

### ⚠️ Critical Architecture Constraints:

* **Header Selection:** You must use the exact strings `### PERFORMANCE`, `### CONTEXT`, and `#### TRANSCRIPT`. Do not use terms like `### DIRECTOR'S NOTES` or `### SCENE DESCRIPTION`—the engine frequently misinterprets the word "director" or "notes" as script dialogue and speaks it aloud.
* **The Transcript Anchor:** The `#### TRANSCRIPT` header functions as a hard execution boundary. Everything above it is treated as silent conditional logic; everything below it is sent directly to the vocal wave synthesis pipeline.

---

## 2. Global Voice Persona Management

Gemini TTS leverages a core library of 30 high-definition prebuilt voices. When instructing your script generator to cast or manage voices, it should select them based on their official acoustic profiles:

### Male Voice Profiles

* **Puck:** Upbeat, casual, highly conversational, and energetic. Classic "friendly peer" timbre.
* **Charon:** Smooth, informative, mid-to-low range pitch. Natural professional narrator voice.
* **Fenrir:** Excitable, gritty, highly dynamic, and punchy. Built for high-tempo performance.
* **Orus:** Deep, resonant, booming, and highly declarative. Carries intense authoritative weight.
* **Enceladus / Aoede:** Breathy, softer presence, lower volume footprint. Minimal harsh plosives.
* **Iapetus / Schedar:** Clear, balanced, and even. Designed for neutral corporate delivery.
* **Algenib:** Heavy, gravelly, mature, deep timbre.
* **Algieba / Achird / Zubenelgenubi:** Conversational, warm, accessible, and informal.
* **Rasalgethi / Sadaltager:** Highly articulate, analytical, and instructional.
* **Alnilam:** Precise, firm, with a low pitch variance.
* **Sadachbia:** Lively, quick-moving, high-pitch male asset.

### Female Voice Profiles

* **Zephyr:** Bright, crisp, modern corporate delivery with a highly clear profile.
* **Kore:** Firm, authoritative, precise diction. Excellent for analytical and formal contexts.
* **Leda / Despina:** Youthful, warm, inviting, and highly smooth profile.
* **Callirrhoe:** Easy-going, clear, mid-range vocal delivery.
* **Autonoe:** Bright, high-pitch, highly declarative.
* **Erinome / Laomedeia:** Rhythmic pacing, upbeat, and naturally cheerful baseline.
* **Achernar:** Soft, gentle, lower volume footprint.
* **Gacrux:** Mature, calm, composed depth.
* **Pulcherrima:** Highly forward, electric, youthful, and enthusiastically energetic.
* **Vindemiatrix:** Gentle, smooth, reassuring style.
* **Sulafat:** Warm, persuasive, and highly deliberate articulation.

---

## 3. Inline Expressive Text Steering (Audio Tags)

To pivot expressions mid-sentence, insert explicit behavioral markers inside standard brackets `[...]` directly into the transcript. Because Gemini is a generative audio model, it supports a vast directory of natural language tags.

### The Documented Emotional & Physical Matrix

* `[excited]` / `[excitedly]` — Elevates delivery speed, pitch variance, and dynamic energy.
* `[shouting]` — Maximizes forward vocal projection and gain without waveform clipping.
* `[screams]` — Pushes the audio into a high-intensity casting or shouting voice.
* `[whispers]` — Drops amplitude, converting speech into soft, air-heavy sibilance.
* `[gasp]` — Forces an immediate, sharp inward intake of breath.
* `[sighs]` — Forces a localized audible exhalation before speaking.
* `[laughs]` / `[giggles]` / `[soft laugh]` — Weaves mild chuckling directly into syllable transitions.
* `[determination]` / `[enthusiasm]` / `[adoration]` — Adjusts tone toward positive/confident registers.
* `[awe]` / `[admiration]` / `[interest]` / `[curiosity]` — Tilts pitch floor upward with an inquisitive cadence.
* `[nervousness]` / `[frustration]` / `[annoyance]` / `[agitation]` — Instabilizes pacing, introducing micro-stutters.
* `[tension]` / `[confusion]` / `[anger]` / `[aggression]` — Hardens consonant sounds, lowering pitch floor.
* `[mischievously]` — Slows tempo slightly, dropping pitch for a sly emphasis.
* `[serious]` — Flattens rhythm, sharpening articulation.
* `[tired]` / `[bored]` / `[reluctantly]` — Drags vowel length, dropping conversational energy.
* `[trembling]` — Unsteadies vocal cords to simulate fear or vulnerability.
* `[slow]` / `[very slow]` — Hard manual speed reduction for targeted phrases.
* `[fast]` / `[very fast]` — Hard manual speed acceleration for targeted phrases.
* `[short pause]` / `[long pause]` / `[pause=X.X]` — Explicitly structures pacing (e.g., `[pause=0.5]`).

### The Formatting Conjunction Rule

When combining text adjustments or inserting inline tags, **never separate them with periods** unless you want a choppy, robotic execution. Connect tags to speech using commas or punctuation marks to maintain vocal fluidity:

* ❌ *Robotic Syntax:* `[excited]. Welcome to the show. [gasp]. It is crazy.`
* ✅ *Fluid Syntax:* `[excited] , Welcome to the show! ... [gasp] , it is crazy!`

---

## 4. Typography Hacks for Human Cadence

The Gemini audio synthesis engine reads standard punctuation layout natively to calculate real human breathing gaps and pitch shifts. Emphasize your script text using these patterns:

* **Ellipses (`...`)** — Inserts an unhurried, natural silent pause (400ms to 800ms). Perfect for building suspense or separating major insights.
* **Hyphenated Strings (`word-by-word`)** — Forcibly compresses the gaps between words, generating a rapid, staccato, breathless execution block.
* **Capitalization (`WHAT DID YOU DO!`)** — Triggers a higher dynamic range volume spike and acute vocal emphasis on the capitalized phrase.

---

## 5. Banned Directives: Avoiding the "Flatness" Trap

If you explicitly tell the engine to be quiet or monotone, the internal vocal scoring mechanism collapses, and it defaults to a flat, highly artificial "AI voice."

* ❌ **Banned Terms in `### PERFORMANCE`:** `quiet`, `quietly`, `flat`, `monotone`, `no rush`, `careful`, `stiff`, `whispered`.
* ✅ **Real-World Replacements:** `warm and sincere`, `voice drops half an octave but remains full of feeling`, `patient and unhurried`, `measured but present`.

---

## 6. Concrete Casting & Speaker Control Examples

### Example A: Single-Speaker Telemetry Caster

This structure is optimized for rapid-fire, high-velocity commentary, data readouts, or live situational play-by-play.

```text
### PERFORMANCE
Style: Infectious enthusiasm and rapid-fire play-by-play commentary. The delivery must mimic a professional live esports shoutcaster, using voiceover-style "vocal smiles" during surprise shifts.
Accent: British English with a clean London/Croydon regional accent.
Pacing: Fast-paced, punchy, and dynamic, accelerating heavily during chaotic sequences.

### CONTEXT
A high-stakes tactical match inside a packed, cheering arena. The clock is ticking down past five seconds, the bomb is actively ticking, and a solo player is attempting a clutch play.

#### TRANSCRIPT
[excitedly] , He is peeking around the brick pillar... he finds the angle... [gasp] , OH MY GOODNESS! What an incredible, instant headshot into the site! ... [very fast] , He-is-going-for-the-ninja-defuse! Can he hit it? ... [screams] , HE GOT IT! Absolute round victory!

```

### Example B: Multi-Speaker Structural Dialogue

Use this configuration layout to manage conversations between distinct characters. Explicitly match the character names inside the transcript to separate their execution paths.

```text
### PERFORMANCE
Speaker 1 (Liam): Upbeat, highly casual, rapid conversational pace, easily breaking into soft laughter mid-sentence.
Speaker 2 (Anya): Measured, intellectual, deeply authoritative yet warm, accessible, and grounded. Speaks with distinct mature precision.

### CONTEXT
Two expert analysts sitting inside a glass broadcasting booth overlooking a massive live tournament floor. Multi-variable data screens are updating telemetry in front of them.

#### TRANSCRIPT
Liam: [cheerfully] , Welcome back to the main analysis desk! We are staring at some absolutely unbelievable economy statistics from that last map phase. Anya, break it down for us.

Anya: [pause=0.5] , [thoughtfully] , It fundamentally comes down to utility conservation, Liam ... [gently] , they managed to float over four thousand dollars per player into the final execute, and that is precisely where the defense fractured.

Liam: [shouting] , Four thousand dollars! — That is completely absurd!

```

```

```