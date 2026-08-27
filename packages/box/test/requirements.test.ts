import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import {
  boxRequirementError,
  collectBoxRequirementOutput,
} from "../src/internal/requirements.ts";

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

  it("suppresses diagnostic output when it cannot be exhaustively redacted", () => {
    const error = boxRequirementError(
      { args: [], command: "setup", name: "setup" },
      { exitCode: 1, stderr: "refreshed-state-secret" },
      [],
      undefined,
      false,
    );

    expect(error.message).toBe('[vitehub] Box requirement "setup" failed: exit code 1');
    expect(error.message).not.toContain("refreshed-state-secret");
  });

  it("includes structured details alongside an exit status", () => {
    const error = boxRequirementError(
      { args: [], command: "setup", name: "setup" },
      { exitCode: 1, message: "provider rejected the credential" },
    );

    expect(error.message).toBe(
      '[vitehub] Box requirement "setup" failed: exit code 1: provider rejected the credential',
    );
  });

  it("serializes structured diagnostic output", () => {
    const error = boxRequirementError(
      { args: [], command: "setup", name: "setup" },
      { exitCode: 1, stderr: { message: "provider rejected the credential" } },
    );

    expect(error.message).toContain('{"message":"provider rejected the credential"}');
    expect(error.message).not.toContain("[object Object]");
  });

  it("caps diagnostics at 4,000 characters including the ellipsis", () => {
    const error = boxRequirementError(
      { args: [], command: "setup", name: "setup" },
      { stderr: "x".repeat(4_001) },
    );
    const diagnostic = error.message.split("failed: ")[1]!;

    expect(diagnostic).toHaveLength(4_000);
    expect(diagnostic.endsWith("…")).toBe(true);
  });

  it("bounds collected output while redacting secrets across chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("credential setup-"));
        controller.enqueue(encoder.encode(`secret\n${"x".repeat(5_000)}`));
        controller.close();
      },
    });

    const output = await collectBoxRequirementOutput(stream, ["setup-secret"]);

    expect(output).toHaveLength(4_000);
    expect(output.startsWith("credential [redacted]")).toBe(true);
    expect(output.endsWith("…")).toBe(true);
    expect(output).not.toContain("setup-secret");
  });
});
