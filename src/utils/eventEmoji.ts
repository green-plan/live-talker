const EVENT_EMOJI: Record<string, string> = {
  kill:              "💀",
  hurt:              "🩸",
  bombPlantStart:    "💣",
  bombPlantStop:     "🚫",
  bombPlant:         "💥",
  bombExplode:       "🔥",
  bombDefuse:        "🛡️",
  defuseStart:       "🔧",
  defuseStop:        "⛔",
  roundEnd:          "🏁",
  matchEnd:          "🏆",
  mvp:               "⭐",
  freezetimeStart:   "❄️",
  freezetimeEnd:     "▶️",
  timeoutStart:      "⏸️",
  timeoutEnd:        "▶️",
  intermissionStart: "🎊",
  intermissionEnd:   "▶️",
};

export function eventEmoji(name: string): string {
  return EVENT_EMOJI[name] ?? "📡";
}
