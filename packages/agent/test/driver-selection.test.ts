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

  it("normalizes bounded driver capacity for custom and built-in drivers", () => {
    const capacity = {
      concurrency: 2,
      queue: { maxPending: 20, timeout: 300_000 },
    };

    for (const driver of [
      { capacity, model: {} },
      { capacity, harness: {} },
      { capacity, run: () => "ok" },
      { capacity, kind: "codex" },
      { capacity, kind: "claude-code" },
    ]) {
      expect(normalizeAgentDriver({ driver } as never)).toMatchObject({ capacity });
    }
  });

  it.each([
    [null, "driver.capacity }) must be an object"],
    [{ concurrency: 0 }, "driver.capacity.concurrency }) must be a positive integer"],
    [{ concurrency: 1.5 }, "driver.capacity.concurrency }) must be a positive integer"],
    [{ concurrency: 1, queue: null }, "driver.capacity.queue }) must be an object"],
    [{ concurrency: 1, queue: { maxPending: 0 } }, "driver.capacity.queue.maxPending }) must be a positive integer"],
    [{ concurrency: 1, queue: { maxPending: 1, timeout: 0 } }, "driver.capacity.queue.timeout }) must be a positive finite number"],
    [{ concurrency: 1, queue: { maxPending: 1, timeout: Number.POSITIVE_INFINITY } }, "driver.capacity.queue.timeout }) must be a positive finite number"],
    [{ concurrency: 1, queue: { maxPending: 1, timeout: 2_147_483_648 } }, "driver.capacity.queue.timeout }) must be a positive finite number no greater than 2147483647"],
  ])("rejects invalid driver capacity %#", (capacity, message) => {
    expect(() => defineAgent({
      driver: { capacity, run: () => "ok" } as never,
      runtime: false,
    })).toThrow(message);
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
