import { useEffect, useRef, useState } from "react";

export interface ClipEvent {
  type: "clip";
  index: number;
  airAt: number;
  durationMs: number;
  transcript: string;
  sourceBeatIds: number[];
}

export interface ClipState {
  clip: ClipEvent | null;
  /** True from the scheduled airAt until durationMs has elapsed. */
  airing: boolean;
  /** Past clips, most recent first — capped at MAX_HISTORY. */
  history: ClipEvent[];
  /** Local reflection of this tab's last toggle — the backend is the source of
   *  truth and applies to all tabs/OBS alike, this is just what this page sent. */
  enabled: boolean;
}

const RECONNECT_DELAY_MS = 2000;
const MAX_HISTORY = 25;

/**
 * Owns the overlay's single WebSocket connection, the audio element it
 * drives, and the airAt-based scheduling math — mirrors what the backend's
 * own airClip() does, so the page never derives delay/timing independently.
 */
export function useClipSchedule(audioRef: React.RefObject<HTMLAudioElement | null>) {
  const [state, setState] = useState<ClipState>({ clip: null, airing: false, history: [], enabled: true });
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket;

    function connect() {
      if (cancelled) return;
      socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/overlay/ws`);
      wsRef.current = socket;

      socket.onmessage = (event) => {
        let msg: ClipEvent;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return; // malformed frame — ignore, never crash the page
        }
        if (msg.type !== "clip") return;

        const audio = audioRef.current;
        const msUntilStart = msg.airAt - Date.now();
        const startPlayback = () => {
          if (!audio) return;
          audio.src = `/overlay/clip/${msg.index}.wav`;
          void audio.play().catch(() => {});
          setState((s) => ({
            ...s,
            clip: msg,
            airing: true,
            history: [msg, ...s.history].slice(0, MAX_HISTORY),
          }));
          setTimeout(() => setState((s) => (s.clip === msg ? { ...s, airing: false } : s)), msg.durationMs);
        };
        if (msUntilStart > 0) setTimeout(startPlayback, msUntilStart);
        else startPlayback();
      };

      socket.onclose = () => {
        if (!cancelled) setTimeout(connect, RECONNECT_DELAY_MS);
      };
      socket.onerror = () => socket.close();
    }

    connect();
    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
  }, [audioRef]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onEnded = () => {
      const index = state.clip?.index;
      if (index === undefined) return;
      wsRef.current?.send(JSON.stringify({ type: "ack", index }));
    };
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onEnded);
    return () => {
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onEnded);
    };
  }, [audioRef, state.clip]);

  function setEnabled(enabled: boolean): void {
    setState((s) => ({ ...s, enabled }));
    wsRef.current?.send(JSON.stringify({ type: "control", enabled }));
  }

  return { ...state, setEnabled };
}
