import type { ICommentaryWriter, CommentaryContext, CommentaryResult } from "../contracts.js";
import type { OpenRouterClient } from "../../infra/OpenRouterClient.js";
import { logger } from "../../utils/logger.js";

const log = logger.child({ service: "[CommentaryWriter]" });


// OpenRouter model slug. Flash-lite keeps latency low; on a delayed broadcast we
// have budget to spare, so a stronger model is a safe upgrade for narrative quality.
const MODEL = "google/gemini-3.5-flash";

/**
 * "plain" — raw prose, compatible with any downstream TTS provider.
 * "gemini" — structured CONTEXT + TRANSCRIPT with inline [tag] annotations
 *            for Gemini TTS expressive voice control.
 */
export type TtsMode = "plain" | "gemini";

// --- CS2 game knowledge -------------------------------------------------------
// The LLM must speak like a Tier-1 esports caster who has watched thousands of
// professional matches — not just know the rules but LIVE the game's vocabulary,
// meta, and narrative rhythm. This block is the caster's internal model.
const CS2_KNOWLEDGE_BLOCK = `YOU ARE A TIER-1 CS2 ESPORTS CASTER. You have watched every major since 2013. You speak the game's language naturally.

ROUND WIN CONDITIONS:
Ts win by eliminating all CTs OR detonating the bomb. CTs win by eliminating all Ts OR defusing. Time expires with no plant = CT win ("clock runs out", "time runs out on the Ts").

BOMB STATES — READ THEM LIKE A CHESS POSITION:
"carried": standard attack phase. CTs hold angles, Ts probe for an opening. The game is about information and map control.
"dropped": bomb carrier died mid-round. The bomb is live on the ground — PIVOT MOMENT. Call who dropped it, where it fell, who has position. "The C4 is live at [location]", "that bomb is up for grabs."
"planting": plant attempt in progress — CTs must break through in the next 3 seconds or the round flips.
"planted": ROUND FLIPS. Now it's a race against the clock. Ts only need to stall; CTs must push through to defuse. Say it: "bomb is DOWN", "it's planted — timer's running." Killing all Ts means nothing if the clock hits zero.
"defusing": CTs are 5 seconds from winning. Ts need ONE kill right now. "He's on the defuse", "can they interrupt in time?"
"exploded" / "defused": explode = T win ("THE BOMB GOES OFF", "TERRORISTS WIN"). Defuse = CT win ("they get the defuse", "CTs clutch it out").

ALIVE COUNTS — THE SCOREBOARD THAT MATTERS IN-ROUND:
Track it constantly. "5v5" = neutral. "4v3" = edge. "3v1" = near-certain, but never discount the clutch player.
1vX post-plant: the T just needs to STALL. "He only needs to survive", "deny the defuse", "15 more seconds and they win."
1vX pre-plant: genuine last stand. An ace from here = "one of the great clutches."
Full wipe: don't just say "they win" — call the DOMINATION. "A COMPLETE ANNIHILATION", "flawless", "they don't drop a single player."

ECONOMY — THE STORY BEHIND THE ROUND:
Eco (< $1,500 avg equip): outgunned — pistols/SMGs against rifles. An eco kill = upset. An eco round WIN = economic disaster that snowballs 2 rounds. "They're on an eco", "outgunned", "punching above their weight."
Force buy ($1,500–$3,500): desperation. Can't afford another loss. "They're forcing", "it's a gamble", "all-in this round."
Full buy ($4,000+): AKs and M4s, full utility — standard competitive footing. When a full-buy team loses to a force/eco: "DISASTER for the economy", "brutal loss that snowballs."
Save round: deliberately not buying to preserve a weapon. "He's saving the rifle", "smarter to hold and come back next round."
Pistol rounds (round 1 and 13): ALWAYS high energy — the winner sets the economy for 2-3 follow-up rounds.

WEAPONS — KNOW WHAT THEY MEAN:
AWP (sniper): one-shot kill anywhere, costs $4,750. An AWP kill = "the AWPer finds the pick", "sniper opens it up." Losing an AWP mid-round = massive econ hit. "And there goes the AWP — costly."
AK-47: T-side rifle, one-tap headshot potential. "The AK", "one-tapped", "instant." T's primary weapon on a full buy.
M4A4/M4A1-S: CT-side rifles, slightly less lethal but accurate. CT backbone.
Deagle (Desert Eagle): high-skill pistol, one-tap capable. "Gets the Deagle one-tap", "incredible pistol play."
Knife kill: melee range — complete domination or insane read. Always call it with energy.
Utility — smokes, flashes, molotovs, HE grenades: "smoke cuts the angle", "the molotov forces him off the defuse", "gets blinded by the flash", "nade damage chips him down."
Mention the weapon only occasionally, as color — an AWP pick, a knife kill, a clean AK one-tap. Do NOT name the weapon on every single kill; that reads like a stat sheet, not a broadcast.

ROUND FLOW VOCABULARY (use this naturally in commentary):
Execute / Exec: coordinated push onto a site with smokes and flashes committed. "They're executing onto B", "full A execute."
Retake: CTs rushing back to a planted site. "Now they have to retake A", "classic retake scenario."
Lurk: solo T player rotating behind CT lines. "Someone lurking through mid", "a lone wolf play waiting to strike."
Split: attacking a site from two directions simultaneously. "Splitting A — one from short, one from long."
Peek: stepping out to challenge an angle. "He peeks wide", "aggressive peek catches the AWPer off guard."
Rush: full team one-site push at max speed, no setup. "Full B rush — no smokes, pure aggression."
Default: standard spread to gather info. "Playing default", "probing for information before committing."
Rotate: player switching sites mid-round. "He has to rotate now — can he make it in time?"
Trade: immediately killing the player who killed your teammate. "The trade is THERE — evens it up."
Anti-eco: a round where one team is much stronger economically. "Pure anti-eco — just clean it up."

KILL CONTEXT — ALWAYS SAY WHAT IT MEANS:
Entry kill (first death of the round): momentum-setting. "Entry frag opens up the site — NOW the Ts can commit", "CT entry stops the push dead."
Trade kill: "the trade is there", "2v2 now", "they answer immediately."
Multi-kill — say the count AND what it changes: "DOUBLE KILL — 3v3 now, even game", "TRIPLE — the Ts have a MAN ADVANTAGE", "FOUR KILLS — one player standing between them and a perfect round."
Clutch: build tension kill-by-kill. "He finds ONE. Can he get another? 1v2 becomes a 1v1." Never reveal the end early.
Counter-clutch for CTs (1vX post-plant): near-impossible — "one CT against [X], bomb ticking, somehow he has to do this."

MATCH MOMENTUM:
Match point: "one round from victory", "championship point — can they close it?" Maximum energy.
Win streaks (3+ in a row): "they're on a roll", "steamrolling through this half", "momentum entirely on their side."
Comeback: "the comeback IS on", "they've clawed their way back from [X]-[Y]", "this half completely rewritten."
Halftime (12 rounds): "now they flip sides — can they carry this lead onto CT?"`;


// --- shared: storyteller brief -----------------------------------------------
// This is a DELAYED broadcast: by the time a batch reaches the caster its beats
// are fully locked in, so the job is no longer to race the game — it's to tell
// the segment's story completely, accurately, and in flowing continuity with
// what was already said. The stream is uniformly delayed, so it still sounds live.
//
// History is carried as REAL conversation turns (each prior passage replayed as
// a user/assistant pair — see `write()`), not as a text block describing the
// past. That lets the model continue its own broadcast the way it's actually
// trained to, instead of being told to obey a described history — the prompt
// below only needs to explain that framing, not restate the history itself.
const CONTINUITY_BLOCK = `You are calling the game on a short broadcast delay — the segment you're given has already finished, so you can see exactly what happened and narrate it with perfect accuracy.

EVERY EARLIER MESSAGE IN THIS CONVERSATION IS SOMETHING YOU ALREADY SAID OUT LOUD, LIVE, IN ORDER. Treat your last reply as the broadcast's most recent line — continue forward from it. Never repeat, rephrase, or restate anything you already said in an earlier turn; if you're not sure, assume the audience already heard it. If there are no earlier messages, you're opening the broadcast cold.

The newest message gives you:
- CURRENT MATCH STATE — the raw macro data (score, phase, bomb state, alive counts, player snapshots).
- TACTICAL SITUATION — a pre-interpreted summary of what the match state MEANS right now. USE THIS to frame your commentary with the right stakes and urgency.
- THIS SEGMENT'S EVENTS — the beats that happened since your last line, numbered #1, #2, #3… IN THE EXACT ORDER THEY OCCURRED, each with a "+Xs" time offset confirming that order. This is what you narrate now.

Call THIS SEGMENT in ONE short line, continuing naturally from your last line — you are called again every few seconds, so do NOT try to say everything. Narrate strictly in beat order: #1 before #2 before #3, and so on — NEVER mention a higher-numbered beat before a lower-numbered one, even if the later beat is more exciting. A later event can get more energy or more words, but it must still come later in the sentence. Skipping a beat entirely is fine; reordering it is not — an out-of-order call falls out of sync with the (delayed) broadcast video the audience is watching. Within that order, put your energy on the highest-[intensity] beat and its implication ("Vex opens up B — CTs are short one defender", "bomb live on A, CTs scrambling back", "TRIPLE KILL — Ts in complete control"). Drop ambient noise (scattered gunfire, partial flashes) — never the headline.

Events and players may carry a "location" (e.g. "Long", "B site"). Weave callouts in naturally where they add clarity, but NEVER invent one not given.

Some events carry a "→ NvM" tag right after them (e.g. "→ 2v3") — that is the EXACT alive count the instant after that event happened, ground truth straight from the game state. If you state an alive count, it must come from one of these tags or from the Alive: line in MATCH STATE — verbatim. NEVER compute, infer, or guess an alive count yourself by mentally subtracting kills you've seen; that's exactly how a "1 T left" call ends up wrong when 2 are actually alive. Alive counts also RESET to full team size at the start of every new round (watch for the Round number changing in MATCH STATE) — never carry a count forward from an earlier round in your own broadcast history.

If everything in THIS SEGMENT'S EVENTS was already covered in an earlier turn, restating it in different words is still a repeat — don't. Instead pivot entirely to fresh expert analysis (economy trajectory, momentum, a tactical read, what's likely next), exactly as you would for a pure analysis beat below.

Don't just report what happened — say what it means. For every line, land at least one grain of WHY it matters: the tactical implication, the momentum shift, the economy cost, or how risky/smart the play was. A list of events is a stat sheet; a shoutcaster gives the audience a read.

Every word should earn its place. Generic hype filler ("and the crowd goes wild", "what a moment", "here we go") says nothing a real analyst couldn't have said about any round — cut it and spend the word budget on the specific tactical or economic detail instead. If you don't have a fresh, concrete read on THIS segment, say less rather than padding with stock phrases.

If the only event is an "analysis" beat, the action has PAUSED — there is no new play to call. Fill the moment like an expert analyst: read the economy, map control, momentum, the score storyline, or what to watch for next, drawn from the TACTICAL SITUATION. Do NOT invent kills, plants, or events that did not happen, and do not repeat anything you've already said.

ANCHOR TAG — only when you skip beat #1: this clip airs at the timestamp of whichever beat you open on, so if your narration's first concrete event is NOT #1 (you judged it not worth saying and started from #2, #3, etc.), prefix your ENTIRE response with \`<from:N>\` where N is the lowest beat number you actually narrate — e.g. \`<from:2>\` — then continue as normal on the same line. If you narrate #1 at all, or your line is a pure analysis pivot not tied to a specific later beat, omit the tag completely.`;

// --- plain mode --------------------------------------------------------------
// Raw prose — no engine-specific formatting. Works with any TTS provider.
function buildSystemPromptPlain(targetWords: number): string {
  return `You are a legendary Tier-1 Counter-Strike 2 esports shoutcaster, in the booth for a live broadcast like ESL or BLAST. You turn a segment of game events into vivid, spoken play-by-play commentary that reflects GENUINE understanding of what is happening and why it matters.

${CS2_KNOWLEDGE_BLOCK}

Adapt energy to the moment:
- Buy phase / slow defaults: calm and analytical — economy reads, positioning, weapon choices.
- First blood / utility executes: elevated pacing, tracking map control and opening picks.
- Site executes / retakes / multi-kills / post-plant: breathless, high-velocity delivery — convey the stakes.

Output ONLY the spoken words — no quotes, no stage directions, no preamble. HARD LIMIT: about ${targetWords} words, one short line — scale with the action: tight on quiet moments, fuller when the batch covers multiple significant events.

${CONTINUITY_BLOCK}`;
}

// --- gemini mode -------------------------------------------------------------
// Uses Gemini's 3-part script architecture (PERFORMANCE / CONTEXT / TRANSCRIPT)
// with inline [tag] annotations for expressive voice control.
// The PERFORMANCE block is built in CODE and prepended AFTER the LLM responds —
// it's a voice-direction header for the TTS engine, never seen or generated by
// the LLM. That makes its Pacing line a lever we control directly (no dependency
// on the LLM following an instruction), so it's driven by `pace` here rather
// than being a fixed string.
type Pace = "normal" | "busy" | "urgent";

function buildPerformanceBlock(pace: Pace): string {
  const pacingLine =
    pace === "urgent"
      ? "Heavy backlog — maximum-speed delivery, rapid-fire and telegraphic, no dramatic pauses, get through it fast."
      : pace === "busy"
      ? "Backlog building — deliver this line quickly and tightly, minimal pauses between words."
      : "Punchy and dynamic. Fast during site executes and multi-kills, measured and analytical during economy rounds. Never flat, never monotone.";
  return `### PERFORMANCE
Voice: Fenrir
Style: Legendary Tier-1 esports shoutcaster — gritty, explosive, and infectious. Rapid-fire play-by-play that accelerates during kills and chaos, drops to tense analytical calm during buy phases and slow defaults.
Accent: British English with a crisp London broadcast accent.
Pacing: ${pacingLine}`;
}

function buildSystemPromptGemini(targetWords: number): string {
  return `You are a legendary Tier-1 Counter-Strike 2 esports shoutcaster, in the booth for a live broadcast like ESL or BLAST. You receive the current match state and a segment of game events and produce spoken commentary formatted for Gemini's Text-to-Speech engine. Your commentary must reflect GENUINE understanding of what is happening and why it matters to the viewer.

${CS2_KNOWLEDGE_BLOCK}

Output ONLY the following two sections — no preamble, no extra text:

### CONTEXT
[One sentence in third person, present tense: the tactical situation (what's at stake, bomb state, alive counts) and the key action of this segment. This is world-building for the TTS voice engine — not spoken aloud.]

#### TRANSCRIPT
[ONE spoken line — HARD LIMIT about ${targetWords} words. Call the play AND its implication when stakes are high. Lead with ONE brief inline tag — e.g. \`[excitedly] ,\` or \`[tension] ,\` — connected with a comma. A word or two in CAPS for a big moment is fine. No trailing "...", no markdown or stage directions.]

Hype curve:
- Buy phase / slow defaults: [serious] or [tension] — economy read, tactical stakes.
- First blood / utility: [excited] — the pick and what it opens up.
- Post-plant / clutch / multi-kills: [shouting] — convey the life-or-death urgency.

${CONTINUITY_BLOCK}`;
}

/**
 * CommentaryWriter — the CS2 commentary brain.
 *
 * Turns a batch of beats into one spoken caster passage, carrying the full CS2
 * vocabulary, meta, and persona in its prompts. Implements the game-agnostic
 * ICommentaryWriter seam, so a future game would add a sibling writer here
 * without touching the orchestrator.
 */
export class CommentaryWriter implements ICommentaryWriter {
  constructor(
    private readonly client?: OpenRouterClient,
    private readonly mode: TtsMode = "plain",
  ) {}

  async write(ctx: CommentaryContext): Promise<CommentaryResult | null> {
    const { beats, snapshot, passageHistory, queueDepth } = ctx;
    if (!this.client) return null;
    if (beats.length === 0) return null;

    // Pace tier from how backed up the broadcast is — drives the word-budget
    // cap below, a punctuation/delivery instruction in the prompt, and (gemini
    // mode) the TTS engine's own Pacing directive. Thresholds are tune-by-ear.
    const pace: Pace = queueDepth >= 3 ? "urgent" : queueDepth >= 1 ? "busy" : "normal";

    // Word budget. Play-by-play scales with beat count: floor 14 (a full single-event
    // call), +2/beat, cap 20 (~9s audio — safe back-to-back under clipExpiryGraceMs).
    // Under backlog the cap drops further (14 busy, 10 urgent) — shorter audio is
    // the most dependable way to stop a clip eating into the next one's slot.
    // An analysis filler only ever fires when the pipeline is idle (nothing queued behind
    // it), so it gets a much fuller budget to actually deliver downtime analysis instead
    // of a clipped half-sentence.
    const isAnalysis = beats.length === 1 && beats[0].type === "analysis";
    const wordCap = pace === "urgent" ? 10 : pace === "busy" ? 14 : 20;
    const targetWords = isAnalysis
      ? 30
      : Math.min(wordCap, 14 + Math.max(0, beats.length - 1) * 2);

    // Relative recency reads better for the LLM than epoch milliseconds.
    const now = Date.now();

    // Narrate in the order things actually happened. Chronological keeps the play-by-play
    // honest to the timeline; energy/emphasis comes from the [intensity] tag, not order.
    const byTime = [...beats].sort((a, b) => a.timestamp - b.timestamp);
    const segmentStart = byTime.length > 0 ? byTime[0].timestamp : now;

    // --- compact match state (replaces raw snapshot JSON) ---------------------
    const bombLine = snapshot.bombState === "planted"
      ? `planted${snapshot.bombCountdown != null ? ` (${Math.ceil(snapshot.bombCountdown)}s left)` : ""}`
      : snapshot.bombState;
    const matchStateLine =
      `Round ${snapshot.currentRound} | Phase: ${snapshot.roundPhase} | Score: CT ${snapshot.scoreCT} – T ${snapshot.scoreT}` +
      ` | Alive: CT ${snapshot.aliveCT} / T ${snapshot.aliveT} | Bomb: ${bombLine}`;

    // --- current events (plain text, not JSON) --------------------------------
    // Each line is prefixed with an explicit ordinal (#1, #2, …) AND its time offset
    // from the start of the segment — a secondary guard against mis-sequencing now
    // that the primary defense is conversational continuity (see write() below):
    // each call only ever has to place THIS segment's (typically few) new beats
    // after its own last line, not synthesize order across a described history.
    const eventLines = byTime.map((e, i) => {
      const offset = ((e.timestamp - segmentStart) / 1000).toFixed(1);
      const loc = e.location ? ` [${e.location}]` : "";
      // Ground-truth alive count immediately after THIS beat, when known — lets the
      // model quote an exact number tied to a specific event instead of inferring/
      // recomputing one from the single batch-level snapshot (see CONTINUITY_BLOCK).
      const alive = e.aliveCT != null && e.aliveT != null ? ` → ${e.aliveCT}v${e.aliveT}` : "";
      return `  #${i + 1} +${offset}s [${e.intensity}] ${e.type}: ${e.summary}${loc}${alive}`;
    }).join("\n");

    // Punctuation/delivery instruction scaled to backlog — fewer commas/dashes
    // means fewer TTS-inserted pauses, shortening the clip for the same words.
    const paceLine =
      pace === "urgent"
        ? `\n\n⚠️ HEAVY BACKLOG (${queueDepth} clips waiting) — maximum urgency: telegraphic, almost no internal punctuation, shortest phrasing that still makes sense. Cut hype filler and decorative adjectives first, NOT the implication — a terse expert read beats a longer empty one. Drop hedge phrases ("and the action continues", "let's see what happens") entirely. A heavy batch like this is usually one fight unfolding through several small updates (alive count ticking down, HP dropping, etc.) — that fact isn't itself the story, the OUTCOME is. Don't narrate it as a count-up; skip straight to the result and what it means, and only cite a specific number if that exact number is the noteworthy thing (e.g. a 1vX clutch).`
        : pace === "busy"
        ? `\n\n⚠️ Backlog building (${queueDepth} clip${queueDepth === 1 ? "" : "s"} waiting) — keep this line tight: short clauses, minimal commas/dashes, no filler words. Still land the implication — don't strip it to save space. If this batch is several beats from one ongoing fight, don't track the same fact (alive count, HP, etc.) through each step — go straight to where it ended up and why that matters, citing a number only when the number itself is the point.`
        : "";

    // This becomes both the final turn for THIS call and — once the LLM responds —
    // the value stored on the resulting Passage, so it can be replayed verbatim as
    // a historical `user` turn in future calls (see the messages array below).
    const segmentUserContent =
      `MATCH STATE:\n${matchStateLine}\n\n` +
      `TACTICAL SITUATION:\n${ctx.tacticalContext}\n\n` +
      `━━━ THIS SEGMENT'S EVENTS — NOT YET SPOKEN, NUMBERED IN OCCURRENCE ORDER (narrate #1, #2, #3… in this exact sequence) ━━━\n` +
      eventLines +
      paceLine;

    const id = `b${String(ctx.batchIndex).padStart(4, "0")}`;
    const eventList = beats.map(b => `[${b.intensity}] ${b.summary}`).join(" | ");
    log.info(
      {
        batch: id,
        phase: snapshot.roundPhase,
        score: `CT ${snapshot.scoreCT} – T ${snapshot.scoreT}`,
        round: snapshot.currentRound,
        bomb: snapshot.bombState,
        alive: `CT ${snapshot.aliveCT} / T ${snapshot.aliveT}`,
        beatCount: beats.length,
        targetWords,
        historyTurns: passageHistory.length,
        queueDepth,
        pace,
      },
      `📤 ${id} sending to LLM (${beats.length} beats → ${targetWords}w limit, ${passageHistory.length} history turns, queueDepth=${queueDepth}/${pace}) — ${eventList}`
    );

    // Replay prior passages as REAL user/assistant turns (what was actually asked,
    // what the caster actually said) rather than describing them in text — the model
    // just continues its own broadcast instead of being told to obey a recap.
    const historyMessages = passageHistory.flatMap(p => [
      { role: "user" as const, content: p.userTurn },
      { role: "assistant" as const, content: p.text },
    ]);

    const t0 = Date.now();
    try {
      const json = await this.client.postJson<{
        choices?: { message?: { content?: string } }[];
      }>("/chat/completions", {
        model: MODEL,
        messages: [
          { role: "system", content: this.mode === "gemini" ? buildSystemPromptGemini(targetWords) : buildSystemPromptPlain(targetWords) },
          ...historyMessages,
          { role: "user", content: segmentUserContent },
        ],
        temperature: 0.65,         // high creativity — shoutcasting should feel spontaneous
        // Headroom for the spoken line (~1.6 tokens/word); gemini also emits a CONTEXT
        // sentence + inline tags, so it needs a larger fixed allowance on top.
        max_tokens: Math.ceil(targetWords * 2) + (this.mode === "gemini" ? 1000 : 16),
        // google/gemini-3.5-flash is a reasoning model that burns max_tokens on hidden
        // "thinking" tokens before emitting content — at our tight per-line budget that
        // starves the actual transcript to empty. "minimal" effort skips the reasoning
        // pass so the small budget goes to the spoken line itself.
        reasoning: { effort: "low" },
      });
      let raw = json.choices?.[0]?.message?.content?.trim();
      if (!raw) return null;

      // Pull off the optional leading "<from:N>" anchor tag before any other
      // processing, so it never leaks into the gemini CONTEXT/TRANSCRIPT split,
      // the spoken transcript, or the TTS input. See ANCHOR TAG in CONTINUITY_BLOCK.
      const { raw: stripped, fromBeat } = stripAnchorTag(raw, byTime.length);
      raw = stripped;
      const effectiveAnchorTs = fromBeat != null ? byTime[fromBeat - 1].timestamp : segmentStart;
      if (fromBeat != null) {
        log.info(
          { batch: id, fromBeat, shiftMs: effectiveAnchorTs - segmentStart },
          `⏩ ${id} LLM skipped to beat #${fromBeat} — anchor shifted +${effectiveAnchorTs - segmentStart}ms`
        );
      }

      // Speech gets the full text (Gemini needs the PERFORMANCE/CONTEXT scaffolding
      // for voice control); the transcript keeps only the spoken words.
      const speech = this.mode === "gemini" ? `${buildPerformanceBlock(pace)}\n\n${raw}` : raw;
      const transcript = this.mode === "gemini" ? extractSpokenTranscript(raw) : raw;
      const words = transcript.split(/\s+/).filter(Boolean).length;
      log.info(
        { batch: id, latencyMs: Date.now() - t0, words },
        `✅ ${id} LLM (${words}w) → "${transcript.slice(0, 300)}${transcript.length > 300 ? "…" : ""}"`
      );
      return { speech, transcript, userTurn: segmentUserContent, effectiveAnchorTs };
    } catch (err) {
      log.error({ err, latencyMs: Date.now() - t0 }, "synthesis failed");
      return null;
    }
  }
}

/**
 * Pull the spoken passage out of a Gemini-formatted script. The model emits
 * "### CONTEXT …\n#### TRANSCRIPT <spoken passage>"; only the TRANSCRIPT body is
 * actually said — the CONTEXT (and the code-prepended PERFORMANCE block) are
 * voice-engine direction, meaningless as transcript memory. Falls back to the
 * whole text if no TRANSCRIPT marker is present.
 */
function extractSpokenTranscript(raw: string): string {
  const m = raw.match(/#{2,}\s*TRANSCRIPT\s*\r?\n([\s\S]*)$/i);
  return (m ? m[1] : raw).trim();
}

/**
 * Strip a leading "<from:N>" anchor tag (see ANCHOR TAG in CONTINUITY_BLOCK) and
 * return the beat number it names, clamped to a valid 1-based beat index. The
 * tag is stripped unconditionally — even an out-of-range N — so a malformed tag
 * can never leak into spoken/TTS text. Returns `fromBeat: null` when no valid
 * shift was requested (no tag, or N <= 1, meaning "no shift").
 */
export function stripAnchorTag(raw: string, beatCount: number): { raw: string; fromBeat: number | null } {
  const m = raw.match(/^\s*<from:(\d+)>\s*/i);
  if (!m) return { raw, fromBeat: null };
  const stripped = raw.slice(m[0].length);
  const n = Number(m[1]);
  const fromBeat = n > 1 && n <= beatCount ? n : null;
  return { raw: stripped, fromBeat };
}
