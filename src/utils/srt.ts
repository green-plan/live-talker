/** One subtitle cue: text and its [start, end] offset on a timeline. */
export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

/** Format a millisecond offset as an SRT timestamp: HH:MM:SS,mmm. */
export function srtTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3_600_000);
  const m = Math.floor((clamped % 3_600_000) / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(millis, 3)}`;
}

/** Serialize cues into SRT format. */
export function buildSrt(cues: readonly Cue[]): string {
  return cues
    .map((cue, i) => `${i + 1}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${cue.text}\n`)
    .join("\n");
}
