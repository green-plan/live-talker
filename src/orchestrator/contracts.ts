import type { RenderedClip } from "../types/pipeline.js";

/**
 * Audio sink seam — the conductor airs a clip through this, never a concrete
 * infra class. `WslAudioPlayer` (desktop) and `OverlayAudioSink` (browser/OBS)
 * are the two implementations.
 */
export interface IAudioSink {
  play(clip: RenderedClip): Promise<void>;
}
