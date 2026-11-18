import { describe, expect, it } from "vitest";
import { formatDuration, initials } from "../src/internal/format.ts";

describe("display formatters", () => {
  it.each([
    [0, "0 ms"],
    [320, "320 ms"],
    [999.4, "999 ms"],
    [999.6, "1000 ms"],
    [1_000, "1.0 s"],
    [1_150, "1.1 s"],
    [1_234, "1.2 s"],
    [1_250, "1.3 s"],
    [9_949, "9.9 s"],
    [9_960, "10.0 s"],
    [10_000, "10 s"],
    [30_000, "30 s"],
    [59_900, "59 s"],
    [60_000, "1 min 0 s"],
    [95_000, "1 min 35 s"],
    [3_605_000, "60 min 5 s"],
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
