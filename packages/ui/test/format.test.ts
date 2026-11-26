import { describe, expect, it, vi } from "vitest";
import { formatDuration, initials } from "../src/internal/format.ts";

describe("display formatters", () => {
  it("loads and formats in a browser without Intl.DurationFormat", async () => {
    vi.stubGlobal("Intl", Object.create(Intl, { DurationFormat: { value: undefined } }));
    vi.resetModules();
    try {
      const fresh = await import("../src/internal/format.ts");
      expect(fresh.formatDuration(95_000)).toBe("1m 35s");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    [0, "0ms"],
    [320, "320ms"],
    [999.4, "999ms"],
    [999.6, "1.0s"],
    [1_000, "1.0s"],
    [1_150, "1.1s"],
    [1_234, "1.2s"],
    [1_250, "1.2s"],
    [9_949, "9.9s"],
    [9_960, "9.9s"],
    [10_000, "10s"],
    [30_000, "30s"],
    [59_900, "59s"],
    [60_000, "1m 0s"],
    [95_000, "1m 35s"],
    [3_605_000, "60m 5s"],
  ])("formats %d ms as %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it("takes two letters from a name or an email address", () => {
    expect(initials("Ana Ruiz")).toBe("AR");
    expect(initials("ana.lopez@vitehub.dev")).toBe("AL");
    expect(initials("Ana Maria de la Cruz")).toBe("AC");
    expect(initials("Ana")).toBe("AN");
    expect(initials("  ")).toBe("?");
  });
});
