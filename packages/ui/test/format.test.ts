import { describe, expect, it } from "vitest";
import { formatDuration, initials } from "../src/internal/format.ts";

describe("display formatters", () => {
  it("formats a duration in the largest unit that keeps it short", () => {
    expect(formatDuration(320)).toBe("320 ms");
    expect(formatDuration(1_234)).toBe("1.2 s");
    expect(formatDuration(30_000)).toBe("30 s");
    expect(formatDuration(59_900)).toBe("59 s");
    expect(formatDuration(95_000)).toBe("1 min 35 s");
  });

  it("takes two letters from a name or an email address", () => {
    expect(initials("Ana Ruiz")).toBe("AR");
    expect(initials("ana.lopez@vitehub.dev")).toBe("AL");
    expect(initials("Ana Maria de la Cruz")).toBe("AC");
    expect(initials("Ana")).toBe("AN");
    expect(initials("  ")).toBe("?");
  });
});
