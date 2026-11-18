import { uiErrorDiagnostics } from "../error-diagnostics.ts";

// A copy of `describeTime` from comark-time (comark-ui, `packages/time/src/describe.ts`), so that `RelativeTime` and a
// Markdown `:time` read the same words. Keep the two in step: `test/relative-time.test.ts` checks the shared cases.

export type DescribeTimeOptions = {
  /** The moment to measure from, as a date, an ISO string, or milliseconds. Defaults to the moment of the call. */
  now?: Date | string | number;
  /** How far from now a date stops reading as relative, as a number and a unit (`3w`), or `none`. Default `3w`. */
  threshold?: string;
  /** A BCP 47 tag for the words and the date format. Default `en-US`. */
  locale?: string;
  /**
   * An IANA zone for the time of day and for which day is today. Defaults to the runtime's zone, which in a browser is
   * the reader's. Local times in a clock gap are invalid; repeated times use the earlier instant.
   */
  timeZone?: string;
  /** How long the words are, as `Intl.RelativeTimeFormat` takes it: `long` ("3 weeks ago"), `short` ("3 wk. ago"), or `narrow`. Default `long`. */
  style?: Intl.RelativeTimeFormatStyle;
};

/**
 * A date as a reader would see it. `datetime` is the ISO date (or the UTC instant, with a time), `label` what the page
 * shows, `tip` the tooltip's text, and `mode` whether `label` is relative words or a date.
 */
export type TimeDescription = {
  datetime: string;
  mode: "relative" | "absolute";
  label: string;
  tip: string;
};

/**
 * Describes a date or an instant against `now`: "3 days ago" with the full date as its tip while it's closer than
 * `threshold`, and from there on "Oct 12" ("Oct 12, 2025" in another year) with the relative words as its tip. A date
 * alone (`2026-10-12`) counts whole calendar days in `timeZone`, and a time with no offset is read in that zone.
 * Returns `undefined` for a value it can't read, and throws an error for a `threshold`, `now`, `locale`, or
 * `timeZone` it can't read.
 */
export function describeTime(
  at: Date | string | number,
  options: DescribeTimeOptions = {},
): TimeDescription | undefined {
  const [SECOND, MINUTE, HOUR, DAY] = [1e3, 6e4, 36e5, 864e5];
  const [WEEK, MONTH, YEAR] = [7 * DAY, 30 * DAY, 365 * DAY];
  const units: Record<string, number> = {
    s: SECOND,
    m: MINUTE,
    h: HOUR,
    d: DAY,
    w: WEEK,
    mo: MONTH,
    y: YEAR,
  };
  const { threshold = "3w", locale = "en-US", style = "long" } = options;
  const [, amount, unit] = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w|mo|y)$/i.exec(threshold) ?? [];
  const limit = /^(none|never)$/i.test(threshold)
    ? Number.POSITIVE_INFINITY
    : amount && unit
      ? Number(amount) * (units[unit.toLowerCase()] ?? Number.NaN)
      : Number.NaN;
  if (Number.isNaN(limit))
    throw uiErrorDiagnostics.UI_RELATIVE_TIME_THRESHOLD_INVALID({ threshold });
  const now = options.now === undefined ? Date.now() : new Date(options.now).getTime();
  if (!Number.isFinite(now))
    throw uiErrorDiagnostics.UI_RELATIVE_TIME_NOW_INVALID();
  const zone = options.timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style });

  const parts = (moment: number) => {
    const found = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      })
        .formatToParts(moment)
        .map((part) => [part.type, Number(part.value)]),
    );
    // SAFETY: the formatter above asks for exactly these six numeric fields, so each is present.
    return found as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
  };
  // How far the zone is ahead of UTC at `moment`, in milliseconds.
  const offsetAt = (moment: number) => {
    const p = parts(moment);
    return (
      Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
      Math.floor(moment / 1e3) * 1e3
    );
  };
  // A date alone is a calendar day (`wall`), and a time with no offset is the zone's.
  const read = (value: string): { at: number; wall: boolean } | undefined => {
    const match =
      /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(
        value,
      );
    if (!match) return undefined;
    const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map((index) =>
      Number(match[index] ?? 0),
    ) as [number, number, number, number, number, number];
    const stamp = Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute,
      second,
      Number((match[7] ?? "").padEnd(3, "0")),
    );
    const check = new Date(stamp);
    // Date.UTC rolls 31 February into March, so a date that doesn't come back as written isn't one.
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day ||
      hour > 23 ||
      minute > 59 ||
      second > 59
    )
      return undefined;
    if (match[4] === undefined) return { at: Math.floor(stamp / DAY) * DAY, wall: true };
    const offset = match[8];
    if (offset?.toUpperCase() === "Z") return { at: stamp, wall: false };
    if (offset) {
      const digits = offset.replace(/\D/g, "");
      const hours = Number(digits.slice(0, 2));
      const rest = Number(digits.slice(2));
      if (hours > 23 || rest > 59) return undefined;
      return {
        at: stamp - (offset.startsWith("-") ? -1 : 1) * (hours * 60 + rest) * 6e4,
        wall: false,
      };
    }
    // Check both sides of a transition: gaps have no match, and folds use the earlier instant.
    const candidates = new Set(
      [stamp - DAY, stamp, stamp + DAY].map((moment) => stamp - offsetAt(moment)),
    );
    const found = [...candidates]
      .filter((moment) => moment + offsetAt(moment) === stamp)
      .sort((a, b) => a - b)[0];
    return found === undefined ? undefined : { at: found, wall: false };
  };

  // A bad zone throws here, before any date is read.
  const today = Math.floor((now + offsetAt(now)) / DAY);
  const instant = typeof at === "string" ? Number.NaN : new Date(at).getTime();
  const when =
    typeof at === "string"
      ? read(at.trim())
      : Number.isFinite(instant)
        ? { at: instant, wall: false }
        : undefined;
  if (!when) return undefined;

  // A date alone counts whole days from today, whatever the time of day.
  const distance = when.wall ? (when.at / DAY - today) * DAY : when.at - now;
  // A date alone is never closer than today, so it reads "today", not "now". The number is cut toward now.
  const size = when.wall ? Math.max(Math.abs(distance), DAY) : Math.abs(distance);
  const [name, per]: [Intl.RelativeTimeFormatUnit, number] =
    size < MINUTE
      ? ["second", SECOND]
      : size < HOUR
        ? ["minute", MINUTE]
        : size < DAY
          ? ["hour", HOUR]
          : size < WEEK
            ? ["day", DAY]
            : size < MONTH
              ? ["week", WEEK]
              : size < YEAR
                ? ["month", MONTH]
                : ["year", YEAR];
  const words = relative.format(Math.trunc(distance / per) || 0, name);
  // A date alone is formatted in UTC, so no zone moves its day.
  const format = (extra: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { timeZone: when.wall ? "UTC" : zone, ...extra }).format(
      when.at,
    );
  const short = { day: "numeric", month: "short" } as const;
  const clock = { hour: "numeric", minute: "2-digit", timeZoneName: "short" } as const;
  const absolute = Math.abs(distance) >= limit;
  const year = when.wall ? new Date(when.at).getUTCFullYear() : parts(when.at).year;
  return {
    datetime: when.wall
      ? new Date(when.at).toISOString().slice(0, 10)
      : new Date(when.at).toISOString().replace(/\.000Z$/, "Z"),
    mode: absolute ? "absolute" : "relative",
    label: absolute
      ? format(year === parts(now).year ? short : { ...short, year: "numeric" })
      : words,
    tip: !absolute
      ? format({ weekday: "short", ...short, year: "numeric", ...(when.wall ? {} : clock) })
      : when.wall
        ? words
        : `${words} · ${format(clock)}`,
  };
}
