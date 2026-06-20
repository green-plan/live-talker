import type {OrchestratorConfig} from "./types/pipeline.js";

/**
 * Default orchestrator tuning, injected into the ShoutCaster at the composition
 * root. Sane defaults — override per instance by passing a different config. The
 * shape lives with the pipeline types; only the chosen values live here.
 */
export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
    tickMs: 10,             // housekeeping cadence — also drives beat detection every tick
    lullMs: 3000,           // silence triggers one analytical filler beat
    beatGapMs: 2500,         // seal after 1s idle — smaller islands so each LLM turn covers fewer
                             // new beats, leaning on conversational continuity instead of a big
                             // multi-event segment competing for narrative priority. Tune by ear.
    batchMaxMs: 5000,        // cap a single clip at Xs of game time — same reasoning as beatGapMs
    delayMs: 10000,          // fixed behind real time — match the OBS feed delay to this
    settleReserveMs: 4000,   // reserved for LLM+TTS+conductor after the settle wait ends
    settleMaxMs: 4000,       // cap how long pickup defers to read incoming pressure
    textConcurrency: 1,      // story is sequential — each passage builds on the last
    speechConcurrency: 4,    // render up to 4 clips at once behind the LLM
    passageHistoryCount: 15, // recent passages fed back as shoutcast history
    beatStoreCapacity: 1000, // ring-buffer cap on retained batches
};
