const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "5 minutes ago", "yesterday", or "now" for under a minute. */
export function timeAgo(at: number, now: number = Date.now()): string {
  const difference = at - now;
  for (const [unit, size] of units) {
    if (Math.abs(difference) >= size) {
      return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(Math.round(difference / size), unit);
    }
  }
  return "now";
}
