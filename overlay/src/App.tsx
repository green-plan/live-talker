import { useRef, useState } from "react";
import { useClipSchedule } from "./hooks/useClipSchedule";
import { BeatVisualizer } from "./components/BeatVisualizer";
import { ShoutcastHistory } from "./components/ShoutcastHistory";

export default function App() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [muted, setMuted] = useState(false);
  const { clip, airing, history, enabled, setEnabled } = useClipSchedule(audioRef);

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-4 p-6">
      {/* ambient dot grid + cyan glow — same motif as the homepage, kept subtle since
          this composites as a small box on top of game footage in OBS. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{
          backgroundImage: "radial-gradient(circle, rgba(148,163,184,0.18) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          maskImage: "radial-gradient(ellipse 70% 60% at 50% 30%, black 40%, transparent 100%)",
        }}
      />
      <div className="pointer-events-none absolute left-1/2 top-1/4 h-48 w-80 -translate-x-1/2 rounded-full bg-cyan-500/20 blur-[80px]" />

      <audio ref={audioRef} muted={muted} />

      <div className="relative z-10 flex items-center gap-2">
        <span className="text-lg font-extrabold tracking-tight text-white">
          live<span className="text-cyan-400">—</span>talker
        </span>
        <span className={`h-1.5 w-1.5 rounded-full bg-cyan-400 ${airing ? "beat-dot" : ""}`} />
      </div>

      <div className="relative z-10 w-full max-w-md space-y-3">
        <BeatVisualizer clip={clip} airing={airing} />
        <ShoutcastHistory history={history} current={airing ? clip : null} />
      </div>

      <div className="relative z-10 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setMuted((m) => !m)}
          className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 font-mono text-[10px] text-slate-300 hover:border-cyan-400/50"
        >
          {muted ? "🔇 muted" : "🔊 unmuted"} — click to {muted ? "unmute" : "mute"}
        </button>
        <button
          type="button"
          onClick={() => setEnabled(!enabled)}
          title="Pauses commentary generation backend-wide (stops LLM/TTS API calls) — affects OBS and every connected tab."
          className={`rounded-full border px-3 py-1 font-mono text-[10px] ${
            enabled
              ? "border-slate-700 bg-slate-900/60 text-slate-300 hover:border-cyan-400/50"
              : "border-amber-400/40 bg-amber-400/10 text-amber-300"
          }`}
        >
          {enabled ? "⏸ pause shoutcasting" : "▶ resume shoutcasting"}
        </button>
      </div>
    </div>
  );
}
