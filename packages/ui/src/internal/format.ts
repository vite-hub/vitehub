// Display formatters that every @vite-hub/ui component shares, so a time, a duration, or a name reads the same in a
// comment, a trace, and a boot checklist.

const relativeUnits: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "5 minutes ago", "yesterday", or "now" for under a minute. */
export function timeAgo(at: number, now: number = Date.now()): string {
  const difference = at - now;
  for (const [unit, size] of relativeUnits) {
    if (Math.abs(difference) >= size) {
      return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(Math.round(difference / size), unit);
    }
  }
  return "now";
}

/** "320 ms", "1.2 s", "30 s", or "1 min 35 s". Seconds round down, so a running counter never shows "60 s". */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1_000;
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.floor(seconds % 60)} s`;
}

/** Two letters for an avatar without an image: `Ana Lopez` and `ana.lopez@vitehub.dev` are `AL`, `Ana` is `AN`. */
export function initials(name: string): string {
  // An email address names its local part.
  const words = name.replace(/@.*/, "").trim().split(/[\s._-]+/).filter(Boolean);
  const first = words[0] ?? "";
  const second = words.length > 1 ? (words.at(-1) ?? "") : first.slice(1);
  return (first.slice(0, 1) + second.slice(0, 1)).toUpperCase() || "?";
}
