import { describe, expect, it } from "vitest";

import { isConsoleHealth } from "../src/console/runtime/components/console-health-model";

const health = {
  checkedAt: "2026-08-30T00:00:00.000Z",
  diagnostics: [{ label: "Storage", status: "ok", value: "Ready" }],
  status: "healthy",
  summary: "Ready",
  workload: { active: 0, completed: 1, failed: 0, snapshots: 1, total: 1 },
};

describe("Console Health model", () => {
  it("accepts the payload rendered by the Health inspector", () => {
    expect(isConsoleHealth(health)).toBe(true);
  });

  it("rejects malformed diagnostics during capability discovery", () => {
    expect(isConsoleHealth({ ...health, diagnostics: [{ label: "Storage" }] })).toBe(false);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects the invalid workload count %s",
    (active) => {
      expect(isConsoleHealth({ ...health, workload: { ...health.workload, active } })).toBe(false);
    },
  );
});
