// Display formatters that every @vite-hub/ui component shares, so a duration or a name reads the same in a
// comment, a trace, and a boot checklist.

const milliseconds = new Intl.DurationFormat("en", { style: "narrow", millisecondsDisplay: "always" });
const tenths = new Intl.DurationFormat("en", { style: "narrow", milliseconds: "numeric", fractionalDigits: 1 });
const minutes = new Intl.DurationFormat("en", { style: "narrow", secondsDisplay: "always" });

/** "320ms", "1.2s", "30s", or "1m 35s". Seconds round down, so a running counter never shows "60s". */
export function formatDuration(ms: number): string {
  const whole = Math.round(ms);
  if (whole < 1_000) return milliseconds.format({ milliseconds: whole });
  // 999.6 ms rounds up to a second, so it reads "1.0s", not "1,000ms".
  const elapsed = Math.max(ms, 1_000);
  const seconds = Math.floor(elapsed / 1_000);
  if (seconds < 10) return tenths.format({ seconds, milliseconds: Math.floor(elapsed % 1_000) });
  if (seconds < 60) return minutes.format({ seconds });
  return minutes.format({ minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

/** Two letters for an avatar without an image: `Ana Lopez` and `ana.lopez@vitehub.dev` are `AL`, `Ana` is `AN`. */
export function initials(name: string): string {
  // An email address names its local part.
  const words = name.replace(/@.*/, "").trim().split(/[\s._-]+/).filter(Boolean);
  const first = words[0] ?? "";
  const second = words.length > 1 ? (words.at(-1) ?? "") : first.slice(1);
  return (first.slice(0, 1) + second.slice(0, 1)).toUpperCase() || "?";
}
