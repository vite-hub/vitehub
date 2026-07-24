import { describe, expect, it } from "vitest";

import { defineAgent } from "../src/index.ts";
import { normalizeAgentDriver } from "../src/internal/agent-driver.ts";

describe("built-in Agent Driver selection", () => {
  it.each([
    ["codex", "codex"],
    ["claude-code", "claude-code"],
  ] as const)("selects %s by literal name", (name, provider) => {
    const driver = normalizeAgentDriver({ driver: name } as never);

    expect(driver).toMatchObject({ kind: "harness", provider });
  });

  it("selects configured Codex by tag before its model option", () => {
    const driver = normalizeAgentDriver({
      driver: { kind: "codex", model: "gpt-5.6-codex", reasoningEffort: "high" },
    } as never);

    expect(driver).toMatchObject({ kind: "harness", provider: "codex" });
  });

  it("requires Claude Code to yield its local sandbox to a Box explicitly", () => {
    const box = { runtime: "trusted-host" as const };

    expect(() => defineAgent({ box, driver: "claude-code", runtime: false }))
      .toThrow("defineAgent({ box }) owns harness execution");
    expect(() => defineAgent({
      box,
      driver: { kind: "claude-code", sandbox: false },
      runtime: false,
    })).not.toThrow();
  });

  it("rejects unknown names, tags, and reserved custom shapes", () => {
    expect(() => defineAgent({ driver: "custom" as never, runtime: false }))
      .toThrow('Unknown Agent Driver "custom"');
    expect(() => defineAgent({ driver: { kind: "custom" } as never, runtime: false }))
      .toThrow('Unknown Agent Driver kind "custom"');
    expect(() => defineAgent({
      driver: { kind: "codex", run: () => "ok" } as never,
      runtime: false,
    })).toThrow("does not support option: run");
  });
});
