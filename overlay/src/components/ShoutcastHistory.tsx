import type { ClipEvent } from "../hooks/useClipSchedule";

interface ShoutcastHistoryProps {
  history: ClipEvent[];
  /** The currently-airing clip, if any — shown highlighted, excluded from the list below it. */
  current: ClipEvent | null;
}

const pad2 = (n: number) => n.toString().padStart(2, "0");
const formatClock = (ms: number) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

export function ShoutcastHistory({ history, current }: ShoutcastHistoryProps) {
  const past = history.filter((c) => c.index !== current?.index);
  if (!current && past.length === 0) return null;

  return (
    <div className="mx-auto w-full max-w-md rounded-xl border border-slate-800 bg-slate-900/70 p-3">
      <p className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-slate-500">
        shoutcast history
      </p>
      <ul className="max-h-32 space-y-1 overflow-y-auto text-xs leading-snug">
        {current && (
          <li className="flex gap-2 text-cyan-300">
            <span className="beat-dot mt-1 h-1 w-1 flex-none rounded-full bg-cyan-400" />
            <span className="flex-none font-mono text-slate-500">{formatClock(current.airAt)}</span>
            <span>{current.transcript}</span>
          </li>
        )}
        {past.map((c) => (
          <li key={c.index} className="flex gap-2 text-slate-400">
            <span className="mt-1.5 h-1 w-1 flex-none rounded-full bg-slate-600" />
            <span className="flex-none font-mono text-slate-500">{formatClock(c.airAt)}</span>
            <span>{c.transcript}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
