import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { boxRequirementError } from "../src/internal/requirements.ts";

describe("Box requirement failures", () => {
  it("reports an effective timeout without retaining raw failure details", () => {
    const failure = Object.assign(new Error("token setup-secret failed"), {
      killed: true,
      signal: "SIGTERM",
      stderr: "token setup-secret failed",
    });
    const error = boxRequirementError(
      {
        args: [],
        command: "setup",
        name: "setup setup-secret",
      },
      failure,
      ["setup-secret"],
      10_000,
    );

    expect(error.message).toBe(
      '[vitehub] Box requirement "setup [redacted]" failed: timed out after 10000ms: token [redacted] failed',
    );
    expect(error).not.toHaveProperty("cause");
    expect(inspect(error, { depth: null })).not.toContain("setup-secret");
  });

  it("redacts whitespace-bearing secrets before trimming diagnostics", () => {
    const error = boxRequirementError(
      { args: [], command: "setup", name: "setup" },
      { stderr: "token setup-secret\n" },
      ["setup-secret\n"],
    );

    expect(error.message).toBe('[vitehub] Box requirement "setup" failed: token [redacted]');
    expect(error.message).not.toContain("setup-secret");
  });
});
