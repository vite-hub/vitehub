import { describe, expect, it } from "vitest";

import {
  consoleUsageCacheHitRate,
  consoleUsageCostPerMillionTokens,
  consoleUsageModelPeriods,
  consoleUsageModelShare,
  consoleUsageTokenSegments,
  formatConsoleUsageCostEvidence,
  formatConsoleUsageShare,
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

describe("Console usage model periods", () => {
  it("keeps every period and leaves periods without the model empty", () => {
    const sonnet = model("sonnet", "1", 10);
    expect(
      consoleUsageModelPeriods(
        [
          { models: [sonnet], start: "2026-08-01T00:00:00.000Z" },
          { models: [model("haiku", "1", 5)], start: "2026-08-02T00:00:00.000Z" },
        ],
        "sonnet",
      ),
    ).toEqual([
      { start: "2026-08-01T00:00:00.000Z", totals: sonnet },
      { start: "2026-08-02T00:00:00.000Z", totals: undefined },
    ]);
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
