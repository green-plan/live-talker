import { useEffect, useState } from "react";
import type { ClipEvent } from "../hooks/useClipSchedule";

const BEAT_SEC = 60 / 135;
const BAR_COUNT = 32;
// Resting height while idle — flat, not "up", so silence reads as silence.
const IDLE_HEIGHT = 6;

// Deterministic "waveform" heights — same stacked-sine idea as homepage's
// CommentaryShowcase, just re-seeded per clip (via index) instead of static.
function barsFor(seed: number) {
  return Array.from({ length: BAR_COUNT }, (_, i) => {
    const phase = i + seed * 7; // reshuffle the wave per clip without randomness
    const h =
      34 +
      28 * Math.abs(Math.sin(phase * 0.45)) +
      18 * Math.abs(Math.sin(phase * 0.12 + 1.5));
    return { height: Math.min(100, Math.round(h)), delay: (i % 4) * (BEAT_SEC / 4) };
  });
}

interface BeatVisualizerProps {
  clip: ClipEvent | null;
  airing: boolean;
}

export function BeatVisualizer({ clip, airing }: BeatVisualizerProps) {
  const [bars, setBars] = useState(() => barsFor(0));

  useEffect(() => {
    if (clip) setBars(barsFor(clip.index));
  }, [clip]);

  return (
    <div className="mx-auto w-full max-w-md">
      <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 shadow-[0_0_40px_rgba(15,23,42,0.6)]">
        <div className="flex h-12 items-end gap-[2px]">
          {bars.map(({ height, delay }, i) => (
            <span
              key={i}
              className={`flex-1 rounded-full bg-gradient-to-t from-cyan-500/40 to-cyan-300 transition-[height] duration-300 ${airing ? "beat-bar" : ""}`}
              style={{ height: `${airing ? height : IDLE_HEIGHT}%`, animationDelay: `${delay}s` }}
            />
          ))}
        </div>
        <p className="mt-2 min-h-[1.1rem] text-center text-xs text-slate-200 transition-opacity duration-300">
          {airing && clip ? clip.transcript : ""}
        </p>
      </div>
    </div>
  );
}
