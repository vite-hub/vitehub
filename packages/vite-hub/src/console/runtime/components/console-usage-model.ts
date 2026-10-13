export type ConsoleUsageMetric = "cost" | "tokens";

/** The usage evidence the Usage page reads from one totals row. */
export interface ConsoleUsageEvidence {
  cacheWriteTokens: number;
  cacheWriteTokensAvailable: boolean;
  cachedInputTokens: number;
  cachedInputTokensAvailable: boolean;
  costAvailable: boolean;
  costEstimated: boolean;
  costUsd: string;
  inputTokens: number;
  inputTokensAvailable: boolean;
  outputTokens: number;
  outputTokensAvailable: boolean;
  pricedInvocations: number;
  totalTokens: number;
  totalTokensAvailable: boolean;
}

export interface ConsoleUsageSegment {
  color: string;
  key: "cacheRead" | "cacheWrite" | "input" | "output";
  label: string;
  value: number;
}

/** A neutral step between background and text, so a mix never looks like a status color. */
const ink = (percent: number) =>
  `color-mix(in oklab, var(--ui-text-highlighted) ${percent}%, var(--ui-bg))`;

/** Adjacent segments keep a visible contrast step in light and dark mode. */
const segmentColors = {
  cacheRead: ink(28),
  cacheWrite: ink(76),
  input: ink(50),
  output: ink(100),
};

function costValue(totals: Pick<ConsoleUsageEvidence, "costUsd">): number {
  return Number(totals.costUsd) || 0;
}

export function consoleUsageMetricValue(
  totals: Pick<ConsoleUsageEvidence, "costUsd" | "totalTokens">,
  metric: ConsoleUsageMetric,
): number {
  return metric === "cost" ? costValue(totals) : totals.totalTokens;
}

/** Ranks models by the selected metric. The other metric and the name break ties. */
export function sortConsoleUsageModels<
  Model extends { costUsd: string; model: string; totalTokens: number },
>(models: readonly Model[], metric: ConsoleUsageMetric): Model[] {
  const other: ConsoleUsageMetric = metric === "cost" ? "tokens" : "cost";
  return models.toSorted(
    (left, right) =>
      consoleUsageMetricValue(right, metric) - consoleUsageMetricValue(left, metric) ||
      consoleUsageMetricValue(right, other) - consoleUsageMetricValue(left, other) ||
      left.model.localeCompare(right.model),
  );
}

/**
 * A model's share of the selected metric, or `null` when it is unknown.
 * Cost shares require complete aggregate cost evidence. Token shares stay independent.
 */
export function consoleUsageModelShare(
  model: Pick<ConsoleUsageEvidence, "costUsd" | "pricedInvocations" | "totalTokens" | "totalTokensAvailable">,
  totals: Pick<ConsoleUsageEvidence, "costAvailable" | "costUsd" | "totalTokens">,
  metric: ConsoleUsageMetric,
): number | null {
  if (metric === "tokens") {
    if (totals.totalTokens <= 0 || (!model.totalTokensAvailable && model.totalTokens === 0)) {
      return null;
    }
    return model.totalTokens / totals.totalTokens;
  }
  const total = costValue(totals);
  return !totals.costAvailable || model.pricedInvocations === 0 || total <= 0 ? null : costValue(model) / total;
}

/**
 * Splits recorded tokens by type. Input counts cache reads and cache writes,
 * so plain input is what remains. `complete` is false when a session did not
 * report every type, because then its cache tokens are counted as plain input.
 * Omit historical response counts that do not partition the recorded session total.
 */
export function consoleUsageTokenSegments(totals: ConsoleUsageEvidence): {
  complete: boolean;
  segments: ConsoleUsageSegment[];
} {
  if (totals.totalTokensAvailable && totals.inputTokens + totals.outputTokens !== totals.totalTokens) {
    return { complete: false, segments: [] };
  }
  return {
    complete:
      totals.inputTokensAvailable &&
      totals.outputTokensAvailable &&
      totals.cachedInputTokensAvailable &&
      totals.cacheWriteTokensAvailable,
    segments: [
      {
        color: segmentColors.input,
        key: "input",
        label: "Input",
        value: Math.max(0, totals.inputTokens - totals.cachedInputTokens - totals.cacheWriteTokens),
      },
      {
        color: segmentColors.cacheRead,
        key: "cacheRead",
        label: "Cache read",
        value: totals.cachedInputTokens,
      },
      {
        color: segmentColors.cacheWrite,
        key: "cacheWrite",
        label: "Cache write",
        value: totals.cacheWriteTokens,
      },
      { color: segmentColors.output, key: "output", label: "Output", value: totals.outputTokens },
    ],
  };
}

/**
 * The share of input read from cache, or `null` without complete input
 * evidence. Cache writes count as misses, because that input was processed in full.
 */
export function consoleUsageCacheHitRate(totals: ConsoleUsageEvidence): number | null {
  if (!totals.inputTokensAvailable || !totals.cachedInputTokensAvailable) return null;
  if (totals.totalTokensAvailable && totals.inputTokens + totals.outputTokens !== totals.totalTokens) {
    return null;
  }
  return totals.inputTokens > 0 ? totals.cachedInputTokens / totals.inputTokens : null;
}

/**
 * USD per million tokens, or `null` unless every run recorded both cost and tokens.
 * A partial cost divided by all tokens would understate the rate.
 */
export function consoleUsageCostPerMillionTokens(totals: ConsoleUsageEvidence): number | null {
  if (
    !totals.costAvailable ||
    !totals.totalTokensAvailable ||
    totals.pricedInvocations === 0 ||
    totals.totalTokens <= 0
  ) {
    return null;
  }
  return (costValue(totals) / totals.totalTokens) * 1_000_000;
}

/** Formats a share with one decimal. A share below 0.1% does not show as zero. */
export function formatConsoleUsageShare(share: number | null): string {
  if (share === null) return "—";
  const percent = share * 100;
  if (percent > 0 && percent < 0.1) return "<0.1%";
  return `${percent.toFixed(1)}%`;
}

/**
 * One model's totals in each period. A period without the model has no
 * recorded usage for it, so its totals are undefined.
 */
export function consoleUsageModelPeriods<Model extends { model: string }>(
  buckets: readonly { models: readonly Model[]; start: string }[],
  model: string,
): Array<{ start: string; totals: Model | undefined }> {
  return buckets.map(bucket => ({
    start: bucket.start,
    totals: bucket.models.find(item => item.model === model),
  }));
}

/** One model row of the Console usage summary. */
export interface ConsoleUsageModelTotals extends ConsoleUsageEvidence {
  averageCostUsd?: string;
  invocations: number;
  invocationsAvailable: boolean;
  model: string;
  reasoningTokens: number;
  reasoningTokensAvailable: boolean;
}

export function formatConsoleUsageTokens(value: number): string {
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 1,
    notation: value >= 10_000 ? "compact" : "standard",
  }).format(value);
}

/** Keeps sub-cent decimal strings exact, so a small recorded cost does not show as $0.00. */
export function formatConsoleUsageCost(value: string, estimated = false): string {
  const resolved = Number(value) || 0;
  if (resolved > 0 && resolved < 0.01 && /^0\.\d+$/.test(value)) {
    return `${estimated ? "~" : ""}$${value}`;
  }
  const display = new Intl.NumberFormat("en", {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(resolved);
  return estimated ? `~${display}` : display;
}

/** Partial evidence shows as "recorded", and no evidence shows as "Unavailable", never as zero. */
export function formatConsoleUsageTokenEvidence(value: number, complete: boolean): string {
  if (!complete && value === 0) return "Unavailable";
  const display = formatConsoleUsageTokens(value);
  return complete ? display : `${display} recorded`;
}

export function formatConsoleUsageCostEvidence(
  value: string,
  estimated: boolean,
  complete: boolean,
): string {
  if (!complete && (Number(value) || 0) === 0) return "Unavailable";
  const display = formatConsoleUsageCost(value, estimated);
  return complete ? display : `${display} recorded`;
}

export function formatConsoleUsagePeriod(value: string, resolution: "day" | "hour"): string {
  return new Intl.DateTimeFormat(
    "en",
    resolution === "hour"
      ? { day: "numeric", hour: "numeric", month: "short" }
      : { day: "numeric", month: "short" },
  ).format(new Date(value));
}

/** The selected metric for one totals row, with the same evidence wording. */
export function formatConsoleUsageValue(
  totals: Pick<
    ConsoleUsageEvidence,
    "costAvailable" | "costEstimated" | "costUsd" | "totalTokens" | "totalTokensAvailable"
  >,
  metric: ConsoleUsageMetric,
): string {
  return metric === "cost"
    ? formatConsoleUsageCostEvidence(totals.costUsd, totals.costEstimated, totals.costAvailable)
    : formatConsoleUsageTokenEvidence(totals.totalTokens, totals.totalTokensAvailable);
}
