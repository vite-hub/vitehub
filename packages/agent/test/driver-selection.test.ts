import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { claudeCodeDriver, codexDriver, createAgentInspectionMetadata, defineAgent, resolveAgentInspectionMetadata } from "../src/index.ts";
import { normalizeAgentDriver } from "../src/internal/agent-driver.ts";

describe("built-in Agent Driver selection", () => {
  it("normalizes the common retry setting into AI SDK call settings", () => {
    // SAFETY: This test needs only the resolver's presence; provider execution is not invoked.
    expect(normalizeAgentDriver({
      driver: { maxRetries: 0, model: {} },
    } as never)).toMatchObject({
      execution: { callSettings: { maxRetries: 0 } },
      kind: "model",
    });

    // SAFETY: This fixture deliberately violates the non-negative retry contract to verify runtime rejection.
    expect(() => normalizeAgentDriver({
      driver: { maxRetries: -1, model: {} },
    } as never)).toThrow("non-negative integer");

    // SAFETY: This fixture deliberately supplies conflicting retry locations to verify runtime rejection.
    expect(() => normalizeAgentDriver({
      driver: {
        execution: { callSettings: { maxRetries: 1 } },
        maxRetries: 0,
        model: {},
      },
    } as never)).toThrow("either directly or in execution.callSettings");
  });

  it.each([
    ["Codex literal", "codex", "codex"],
    ["Claude Code literal", "claude-code", "claude-code"],
    ["Codex tagged config", { kind: "codex" }, "codex"],
    ["Claude Code tagged config", { kind: "claude-code" }, "claude-code"],
    ["Codex helper", codexDriver(), "codex"],
    ["Claude Code helper", claudeCodeDriver(), "claude-code"],
  ])("defaults %s permissions to ask", (_label, input, provider) => {
    // SAFETY: The table contains only supported built-in Driver configuration forms.
    const driver = normalizeAgentDriver({ driver: input } as never);

    expect(driver).toMatchObject({ kind: "provider", permissions: "ask", provider });
  });

  it.each(["ask", "allow-edits", "allow-all"] as const)("preserves explicit %s provider permissions", (permissions) => {
    for (const provider of ["codex", "claude-code"] as const) {
      expect(normalizeAgentDriver({ driver: { kind: provider, permissions } })).toMatchObject({
        kind: "provider",
        permissions,
        provider,
      });
    }
  });

  it("reports effective provider permissions in Agent inspection metadata", async () => {
    const defaultAgent = defineAgent({ driver: { kind: "codex", model: "gpt-5.6-sol" } });
    const fullAccessAgent = defineAgent({ driver: { kind: "claude-code", permissions: "allow-all" } });

    expect(createAgentInspectionMetadata(defaultAgent).config?.driver.provider).toEqual({
      model: "gpt-5.6-sol",
      permissions: "ask",
      provider: "codex",
    });
    expect((await resolveAgentInspectionMetadata(defaultAgent)).config?.driver.provider).toEqual({
      model: "gpt-5.6-sol",
      permissions: "ask",
      provider: "codex",
    });
    expect(createAgentInspectionMetadata(fullAccessAgent).config?.driver.provider).toEqual({
      permissions: "allow-all",
      provider: "claude-code",
    });
    expect((await resolveAgentInspectionMetadata(fullAccessAgent)).config?.driver.provider).toEqual({
      permissions: "allow-all",
      provider: "claude-code",
    });
  });

  it("preserves provider environment keys that overlap object prototype accessors", () => {
    const env = { ["__proto__"]: "literal" };

    const driver = normalizeAgentDriver({ driver: { env, kind: "codex" } });
    if (driver.kind !== "provider") throw new TypeError("Expected a provider driver.");
    env.__proto__ = "changed";

    expect(driver.env).toHaveProperty("__proto__", "literal");
  });

  it.each([
    ["execution", "invalid", "driver.execution }) must be an object"],
    ["execution", { unsupported: true }, "driver.execution }) does not support option: unsupported"],
    ["execution.attachments", { attachments: "invalid" }, "driver.execution.attachments }) must be an object"],
    ["execution.attachments", { attachments: { unsupported: true } }, "driver.execution.attachments }) does not support option: unsupported"],
    ["execution.attachments.maxBytes", { attachments: { maxBytes: Number.NaN } }, "driver.execution.attachments.maxBytes }) must be a positive finite number"],
  ])("rejects invalid provider %s", (_label, execution, message) => {
    expect(() => defineAgent({
      // SAFETY: This table deliberately supplies malformed provider execution shapes to verify runtime rejection.
      driver: { execution, kind: "codex" } as never,
      runtime: false,
    })).toThrow(message);
  });

  it("accepts provider execution settings from another realm", () => {
    const execution = runInNewContext("({ attachments: { maxBytes: 1024 } })");

    // SAFETY: The cross-realm fixture has the provider execution shape exercised by this test.
    expect(normalizeAgentDriver({
      driver: { execution, kind: "codex" },
    } as never)).toMatchObject({ execution: { attachments: { maxBytes: 1024 } } });
  });

  it("normalizes Codex credentials, reasoning, and provider settings", () => {
    const credentials = { unseal: () => "{}" };
    const providerSettings = { launchArgs: "--enable responses_websockets_v2" };
    const driver = normalizeAgentDriver({
      driver: {
        credentials,
        kind: "codex",
        model: "gpt-5.6-sol",
        providerSettings,
        reasoningEffort: "high",
        reasoningSummary: "detailed",
      },
    });
    providerSettings.launchArgs = "changed";

    expect(driver).toMatchObject({
      credentials,
      kind: "provider",
      model: "gpt-5.6-sol",
      provider: "codex",
      providerSettings: { launchArgs: "--enable responses_websockets_v2" },
      reasoningEffort: "high",
      reasoningSummary: "detailed",
    });
    const agent = defineAgent({ driver: {
      credentials,
      kind: "codex",
      model: "gpt-5.6-sol",
      providerSettings: { launchArgs: "--enable responses_websockets_v2" },
      reasoningEffort: "high",
      reasoningSummary: "detailed",
    } });
    expect(createAgentInspectionMetadata(agent).config?.driver.provider).toEqual({
      credentials: true,
      model: "gpt-5.6-sol",
      permissions: "ask",
      provider: "codex",
      providerSettings: ["launchArgs"],
      reasoningEffort: "high",
      reasoningSummary: "detailed",
    });
  });

  it.each([
    [{ kind: "claude-code", credentials: "{}" }, "does not support Codex option: credentials"],
    [{ kind: "claude-code", model: "claude", reasoningEffort: "high" }, "does not support Codex option: reasoningEffort"],
    [{ kind: "codex", credentials: "{}", providerSettings: { shadowHomePath: "/tmp/codex" } }, "owns the Codex shadow home"],
    [{ kind: "codex", reasoningEffort: "high" }, "requires driver.model"],
    [{ kind: "codex", model: "gpt-5.6-sol", reasoningSummary: "verbose" }, "must be \"auto\", \"concise\", \"detailed\", or \"none\""],
    [{ kind: "codex", providerSettings: [] }, "driver.providerSettings }) must be an object"],
  ])("rejects invalid provider options %#", (driver, message) => {
    expect(() => normalizeAgentDriver({ driver } as never)).toThrow(message);
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
      // SAFETY: This table deliberately supplies malformed capacity shapes to verify runtime rejection.
      driver: { capacity, run: () => "ok" } as never,
      runtime: false,
    })).toThrow(message);
  });

  it("rejects unknown names, tags, and reserved custom shapes", () => {
    // SAFETY: This fixture deliberately supplies an unknown built-in name to verify runtime rejection.
    expect(() => defineAgent({ driver: "custom" as never, runtime: false }))
      .toThrow('Unknown Agent Driver "custom"');
    // SAFETY: This fixture deliberately supplies an unknown built-in tag to verify runtime rejection.
    expect(() => defineAgent({ driver: { kind: "custom" } as never, runtime: false }))
      .toThrow('Unknown Agent Driver kind "custom"');
    expect(() => defineAgent({
      // SAFETY: This fixture deliberately combines incompatible driver fields to verify runtime rejection.
      driver: { kind: "codex", run: () => "ok" } as never,
      runtime: false,
    })).toThrow("does not support option: run");
  });
});
