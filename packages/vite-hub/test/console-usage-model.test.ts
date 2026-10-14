import { afterEach, describe, expect, it } from "vitest";

import {
  consoleUsageCacheHitRate,
  consoleUsageChartState,
  consoleUsageChartTicks,
  consoleUsageCostPerMillionTokens,
  consoleUsageModelChartPoints,
  consoleUsageModelShare,
  consoleUsagePointEvidence,
  consoleUsageTokenSegments,
  describeConsoleUsageChart,
  formatConsoleUsageCostEvidence,
  formatConsoleUsageDateTime,
  formatConsoleUsagePeriod,
  formatConsoleUsageShare,
  formatConsoleUsageTimestamp,
  formatConsoleUsageValue,
  sortConsoleUsageModels,
  type ConsoleUsageEvidence,
} from "../src/console/runtime/components/console-usage-model.ts";

function evidence(overrides: Partial<ConsoleUsageEvidence> = {}): ConsoleUsageEvidence {
  return {
    cacheWriteTokens: 0,
    cacheWriteTokensAvailable: true,
    cachedInputTokens: 0,
    cachedInputTokensAvailable: true,
    costAvailable: true,
    costEstimated: false,
    costUsd: "0",
    inputTokens: 0,
    inputTokensAvailable: true,
    outputTokens: 0,
    outputTokensAvailable: true,
    pricedInvocations: 1,
    totalTokens: 0,
    totalTokensAvailable: true,
    ...overrides,
  };
}

const model = (name: string, costUsd: string, totalTokens: number, overrides: Partial<ConsoleUsageEvidence> = {}) => ({
  ...evidence({ costUsd, totalTokens, ...overrides }),
  model: name,
});

describe("Console usage model ranking", () => {
  const expensive = model("expensive", "9", 100);
  const busy = model("busy", "1", 300);

  it("orders models by the selected metric", () => {
    expect(sortConsoleUsageModels([busy, expensive], "cost").map(item => item.model)).toEqual([
      "expensive",
      "busy",
    ]);
    expect(sortConsoleUsageModels([expensive, busy], "tokens").map(item => item.model)).toEqual([
      "busy",
      "expensive",
    ]);
  });

  it("breaks ties with the other metric, then the model name", () => {
    const models = [model("b", "1", 10), model("a", "1", 10), model("c", "1", 20)];
    expect(sortConsoleUsageModels(models, "cost").map(item => item.model)).toEqual(["c", "a", "b"]);
  });

  it("derives the share from the selected metric", () => {
    const totals = evidence({ costUsd: "10", totalTokens: 400 });
    expect(consoleUsageModelShare(expensive, totals, "cost")).toBeCloseTo(0.9);
    expect(consoleUsageModelShare(expensive, totals, "tokens")).toBeCloseTo(0.25);
  });

  it("has no cost share without recorded cost but keeps its token share", () => {
    const unpriced = model("local", "0", 100, { costAvailable: false, pricedInvocations: 0 });
    const totals = evidence({ costUsd: "10", totalTokens: 400 });
    expect(consoleUsageModelShare(unpriced, totals, "cost")).toBeNull();
    expect(consoleUsageModelShare(unpriced, totals, "tokens")).toBeCloseTo(0.25);
    expect(formatConsoleUsageShare(null)).toBe("—");
  });

  it("has no cost share when another model lacks cost evidence", () => {
    const priced = model("priced", "9", 100);
    const unpriced = model("local", "0", 300, { costAvailable: false, pricedInvocations: 0 });
    const totals = evidence({
      costAvailable: false,
      costUsd: "9",
      totalTokens: priced.totalTokens + unpriced.totalTokens,
    });
    expect(consoleUsageModelShare(priced, totals, "cost")).toBeNull();
    expect(consoleUsageModelShare(priced, totals, "tokens")).toBeCloseTo(0.25);
    expect(consoleUsageModelShare(unpriced, totals, "tokens")).toBeCloseTo(0.75);
  });

  it("does not round a small share down to zero", () => {
    expect(formatConsoleUsageShare(0.0004)).toBe("<0.1%");
    expect(formatConsoleUsageShare(0)).toBe("0.0%");
    expect(formatConsoleUsageShare(0.61)).toBe("61.0%");
  });
});

describe("Console usage token mix", () => {
  it("splits input into plain input, cache reads, and cache writes", () => {
    const totals = evidence({
      cacheWriteTokens: 20,
      cachedInputTokens: 50,
      inputTokens: 100,
      outputTokens: 30,
      totalTokens: 130,
    });
    expect(consoleUsageTokenSegments(totals)).toEqual({
      complete: true,
      segments: [
        expect.objectContaining({ key: "input", value: 30 }),
        expect.objectContaining({ key: "cacheRead", value: 50 }),
        expect.objectContaining({ key: "cacheWrite", value: 20 }),
        expect.objectContaining({ key: "output", value: 30 }),
      ],
    });
    expect(consoleUsageCacheHitRate(totals)).toBeCloseTo(0.5);
  });

  it("marks the mix as recorded evidence when a type was not reported", () => {
    const totals = evidence({ cachedInputTokensAvailable: false, inputTokens: 100, outputTokens: 10, totalTokens: 110 });
    expect(consoleUsageTokenSegments(totals).complete).toBe(false);
    expect(consoleUsageCacheHitRate(totals)).toBeNull();
  });

  it("omits a historical response mix that does not partition the session total", () => {
    const totals = evidence({
      totalTokens: 59222,
      inputTokens: 21267,
      outputTokens: 118,
      cachedInputTokens: 20352,
      cacheWriteTokens: 100,
    });
    expect(consoleUsageTokenSegments(totals)).toEqual({ complete: false, segments: [] });
    expect(consoleUsageCacheHitRate(totals)).toBeNull();
  });

  it("never shows a negative plain input", () => {
    const totals = evidence({ cachedInputTokens: 120, inputTokens: 100, totalTokens: 100 });
    expect(consoleUsageTokenSegments(totals).segments[0]?.value).toBe(0);
  });
});

describe("Console usage model rates", () => {
  it("reports the cost per million tokens only with complete cost and token evidence", () => {
    expect(consoleUsageCostPerMillionTokens(evidence({ costUsd: "3", totalTokens: 2_000_000 }))).toBe(1.5);
    expect(
      consoleUsageCostPerMillionTokens(
        evidence({ costAvailable: false, costUsd: "3", totalTokens: 2_000_000 }),
      ),
    ).toBeNull();
    expect(
      consoleUsageCostPerMillionTokens(evidence({ costUsd: "0", pricedInvocations: 0, totalTokens: 10 })),
    ).toBeNull();
  });
});

describe("Console usage model chart points", () => {
  it("shows zero for a complete period without the model and unavailable for an incomplete one", () => {
    const sonnet = model("sonnet", "1", 10);
    const points = consoleUsageModelChartPoints(
      [
        { ...evidence({ costUsd: "1", totalTokens: 10 }), models: [sonnet], start: "2026-08-01T00:00:00.000Z" },
        { ...evidence({ costUsd: "1", totalTokens: 5 }), models: [model("haiku", "1", 5)], start: "2026-08-02T00:00:00.000Z" },
        { ...evidence({ totalTokensAvailable: false }), models: [], start: "2026-08-03T00:00:00.000Z" },
      ],
      "sonnet",
      "tokens",
      "day",
    );
    expect(points.map(({ display, evidence, period, value }) => ({ display, evidence, period, value }))).toEqual([
      { display: "10", evidence: "complete", period: "Aug 1", value: 10 },
      { display: "0", evidence: "complete", period: "Aug 2", value: 0 },
      { display: "Unavailable", evidence: "unavailable", period: "Aug 3", value: 0 },
    ]);
  });
});

describe("Console usage chart ticks", () => {
  it("uses 1, 2, or 5 steps for small costs", () => {
    expect(consoleUsageChartTicks(0.46)).toEqual([0, 0.2, 0.4, 0.6]);
    expect(consoleUsageChartTicks(0.003)).toEqual([0, 0.001, 0.002, 0.003]);
    expect(consoleUsageChartTicks(0.3)).toEqual([0, 0.1, 0.2, 0.3]);
  });

  it("uses 1, 2, or 5 steps for large token counts", () => {
    expect(consoleUsageChartTicks(1_234_567)).toEqual([0, 500_000, 1_000_000, 1_500_000]);
    expect(consoleUsageChartTicks(80_000)).toEqual([0, 20_000, 40_000, 60_000, 80_000]);
    expect(consoleUsageChartTicks(7)).toEqual([0, 2, 4, 6, 8]);
  });

  it("keeps one zero tick without a positive peak", () => {
    expect(consoleUsageChartTicks(0)).toEqual([0]);
  });
});

describe("Console usage period labels", () => {
  const timeZone = process.env.TZ;
  afterEach(() => {
    if (timeZone === undefined) delete process.env.TZ;
    else process.env.TZ = timeZone;
  });

  it("labels server buckets in UTC in a browser west of UTC", () => {
    process.env.TZ = "America/Los_Angeles";
    // The local date is Oct 12 here, but the server bucket is the UTC day Oct 13.
    expect(new Date("2026-10-13T00:00:00.000Z").getDate()).toBe(12);
    expect(formatConsoleUsagePeriod("2026-10-13T00:00:00.000Z", "day")).toBe("Oct 13");
    expect(formatConsoleUsagePeriod("2026-10-13T05:00:00.000Z", "hour")).toBe("Oct 13, 5 AM");
  });
});

describe("Console usage evidence wording", () => {
  it("keeps recorded and unavailable wording for partial evidence", () => {
    expect(formatConsoleUsageCostEvidence("0", false, false)).toBe("Unavailable");
    expect(formatConsoleUsageCostEvidence("2.5", true, false)).toBe("~$2.50 recorded");
    expect(
      formatConsoleUsageValue(evidence({ totalTokens: 12_000, totalTokensAvailable: false }), "tokens"),
    ).toBe("12K recorded");
  });
});

describe("Console usage chart evidence", () => {
  it("keeps unknown periods apart from zero periods", () => {
    expect(consoleUsagePointEvidence(evidence(), "cost")).toBe("complete");
    expect(consoleUsagePointEvidence(evidence({ costAvailable: false }), "cost")).toBe("unavailable");
    expect(consoleUsagePointEvidence(evidence({ costAvailable: false, costUsd: "0.2" }), "cost")).toBe("partial");
    expect(consoleUsagePointEvidence(evidence({ totalTokensAvailable: false }), "tokens")).toBe("unavailable");
  });

  it("reports an unavailable chart only when no period recorded a value", () => {
    expect(consoleUsageChartState([])).toBe("zero");
    expect(consoleUsageChartState([{ evidence: "complete", value: 0 }])).toBe("zero");
    expect(consoleUsageChartState([{ evidence: "complete", value: 0 }, { evidence: "unavailable", value: 0 }])).toBe("unavailable");
    expect(consoleUsageChartState([{ evidence: "unavailable", value: 0 }, { evidence: "partial", value: 2 }])).toBe("data");
  });

  it("describes the range, the peak, and the periods without evidence", () => {
    const point = (period: string, value: number, evidence: "complete" | "partial" | "unavailable" = "complete") =>
      ({ display: evidence === "unavailable" ? "Unavailable" : `${value} tokens`, evidence, period, start: period, value });
    expect(describeConsoleUsageChart(
      [point("Oct 1", 5), point("Oct 2", 9, "partial"), point("Oct 3", 0, "unavailable")],
      { from: "Oct 1", to: "Oct 3" },
    )).toBe("Oct 1 to Oct 3 UTC, 3 periods. Peak 9 tokens on Oct 2. 1 period has no evidence. 1 period has partial evidence.");
    expect(describeConsoleUsageChart([point("Oct 1", 0)], { from: "Oct 1", to: "Oct 1" })).toBe("Oct 1 to Oct 1 UTC, 1 period.");
  });
});

describe("Console usage timestamps", () => {
  it("shows minutes in the row and the full date and time in the title", () => {
    expect(formatConsoleUsageTimestamp("2026-10-13T14:05:09.000Z", "UTC")).toBe("Oct 13, 2:05 PM");
    expect(formatConsoleUsageDateTime("2026-10-13T14:05:09.000Z", "UTC")).toBe("Tuesday, October 13, 2026 at 2:05:09 PM UTC");
  });
});
