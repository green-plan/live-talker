/** Format a millisecond timestamp as a local-time HH:MM:SS clock string. */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Correlative batch trace id used across the pipeline logs, e.g. 42 → "b0042". */
export function batchTrace(index: number): string {
  return `b${String(index).padStart(4, "0")}`;
}
