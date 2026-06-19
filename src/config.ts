import type { OrchestratorConfig } from "./types/pipeline.js";

/**
 * Default orchestrator tuning, injected into the ShoutCaster at the composition
 * root. Sane defaults — override per instance by passing a different config. The
 * shape lives with the pipeline types; only the chosen values live here.
 */
export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  tickMs: 100,             // conductor poll cadence — sub-clip resolution is plenty
  interpretMs: 2000,       // beat processing cadence — timestamp accuracy comes from the snapshot walk, not this
  settleMs: 15000,         // process only data ≥2s old so each window is complete before we read it
  lullMs: 10000,           // 10s of settled silence triggers one analytical filler beat
  beatGapMs: 2000,         // seal after 2s idle — tighter islands keep each clip close to its action; ≥2× interpretMs
  batchMaxMs: 4000,        // cap a single clip at 4s of game time — finer granularity
  delayMs: 22000,          // fixed ~22s behind real time — match the OBS feed delay to this
  textConcurrency: 1,      // story is sequential — each passage builds on the last
  speechConcurrency: 4,    // render up to 4 clips at once behind the LLM
  passageHistoryCount: 15, // recent passages fed back as shoutcast history
  beatStoreCapacity: 1000, // ring-buffer cap on retained batches
};
