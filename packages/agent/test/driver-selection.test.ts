import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { claudeCodeDriver, codexDriver, defineAgent } from "../src/index.ts"
import { createAgentInspectionMetadata, resolveAgentInspectionMetadata } from "../src/workspace-agent.ts"
import { normalizeAgentDriver } from "../src/internal/agent-driver.ts";

describe("built-in Agent Driver selection", () => {
  it("preserves and validates static provider exit callbacks", () => {
    const onExit = vi.fn();
    expect(normalizeAgentDriver({ driver: codexDriver({ launch: { command: "codex", onExit } }) })).toMatchObject({
      launch: { command: "codex", onExit },
    });
    // SAFETY: This fixture supplies an invalid callback to test runtime validation.
    expect(() => defineAgent({ driver: codexDriver({ launch: { command: "codex", onExit: "invalid" } } as never) })).toThrow("driver.launch.onExit");
  });

  it("keeps and validates provider Driver requirements", () => {
    expect(normalizeAgentDriver({ driver: codexDriver({ requirements: ["git", "gh", "apply_patch"] }) })).toMatchObject({
      requirements: ["git", "gh", "apply_patch"],
    });
    // SAFETY: This fixture supplies a shell expression to test runtime validation.
    expect(() => defineAgent({ driver: codexDriver({ requirements: ["git; rm -rf /"] }) } as never)).toThrow("driver.requirements");
    expect(normalizeAgentDriver({ driver: codexDriver({ launch: { command: "ssh", args: ["host", "codex"] }, requirements: [] }) })).toMatchObject({
      launch: { command: "ssh", args: ["host", "codex"] },
      requirements: [],
    });
    expect(() => defineAgent({ driver: codexDriver({ launch: { command: "ssh", args: ["host", "codex"] }, requirements: ["git"] }) } as never)).toThrow("launch resolver");
  });

  it.each(["-v", "--", "-missing"])("rejects option-like Driver requirement %s", requirement => {
    expect(() => defineAgent({ driver: codexDriver({ requirements: [requirement] }) })).toThrow("driver.requirements");
  });

  it("accepts callback and object launch resolvers with requirements", () => {
    const launch = ({ command }: { command: string }) => ({ command: "ssh", args: ["host", command] });
    for (const resolver of [launch, { resolve: launch }]) {
      expect(normalizeAgentDriver({ driver: codexDriver({ launch: resolver, requirements: ["git"] }) })).toMatchObject({
        launch: resolver,
        requirements: ["git"],
      });
    }
  });

  it("exposes provider requirements in inspection metadata", () => {
    const agent = defineAgent({ driver: codexDriver({ requirements: ["git", "gh"] }) });
    expect(createAgentInspectionMetadata(agent).config?.driver.provider).toMatchObject({ requirements: ["git", "gh"] });
  });

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
    ["Codex", codexDriver(), "codex"],
    ["Claude Code", claudeCodeDriver(), "claude-code"],
  ])("defaults %s permissions to ask", (_label, input, provider) => {
    const driver = normalizeAgentDriver({ driver: input });

    expect(driver).toMatchObject({ kind: "provider", permissions: "ask", provider });
  });

  it.each([
    ["codex", "codexDriver"],
    ["claude-code", "claudeCodeDriver"],
  ])("rejects %s provider Drivers that do not come from the factory", (provider, factory) => {
    // SAFETY: These fixtures deliberately supply the removed name and tagged object forms.
    expect(() => normalizeAgentDriver({ driver: provider } as never)).toThrow(`Use driver: ${factory}() from vite-hub/agent.`);
    // SAFETY: See above.
    expect(() => normalizeAgentDriver({ driver: { kind: provider } } as never)).toThrow(`must come from ${factory}()`);
  });

  it.each(["ask", "allow-edits", "allow-edits-unattended", "allow-all"] as const)("preserves explicit %s provider permissions", (permissions) => {
    for (const provider of ["codex", "claude-code"] as const) {
      expect(normalizeAgentDriver({ driver: (provider === "codex" ? codexDriver : claudeCodeDriver)({ permissions }) })).toMatchObject({
        kind: "provider",
        permissions,
        provider,
      });
    }
  });

  it("reports effective provider permissions in Agent inspection metadata", async () => {
    const defaultAgent = defineAgent({ driver: codexDriver({ model: "gpt-5.6-sol" }) });
    const fullAccessAgent = defineAgent({ driver: claudeCodeDriver({ permissions: "allow-all" }) });

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

  it("reports public Codex settings and credential presence without resolving credentials", async () => {
    const credentials = vi.fn(() => "{}")
    const agent = defineAgent({
      driver: codexDriver({
        credentialProfile: "support",
        credentials,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        reasoningSummary: "detailed",
      }),
    })

    expect(createAgentInspectionMetadata(agent).config?.driver.executionAuthority.credentials).toBe("provisioned")
    expect((await resolveAgentInspectionMetadata(agent)).config?.driver.executionAuthority.credentials).toBe("provisioned")
    expect(createAgentInspectionMetadata(agent).config?.driver.provider).toMatchObject({
      credentialProfile: "support",
      reasoningEffort: "high",
      reasoningSummary: "detailed",
    })
    expect((await resolveAgentInspectionMetadata(agent)).config?.driver.provider).toMatchObject({
      credentialProfile: "support",
      reasoningEffort: "high",
      reasoningSummary: "detailed",
    })
    expect(credentials).not.toHaveBeenCalled()
  })

  it("rejects Codex-only options on Claude Code and conflicting Codex Home inputs", () => {
    expect(() => defineAgent({
      // SAFETY: This fixture deliberately supplies a Codex-only option to Claude Code.
      driver: claudeCodeDriver({ credentials: () => "{}" } as never),
    })).toThrow("does not support Codex option: credentials")
    expect(() => defineAgent({
      driver: codexDriver({ credentials: () => "{}", env: { CODEX_HOME: "/tmp/codex" } }),
    })).toThrow("owns CODEX_HOME")
    expect(() => defineAgent({
      // SAFETY: This fixture deliberately omits the credential source required by a profile.
      driver: codexDriver({ credentialProfile: "support" } as never),
    })).toThrow("requires driver.credentials")
    expect(() => defineAgent({
      driver: codexDriver({ credentialProfile: "../support", credentials: () => "{}" }),
    })).toThrow("must start with a lowercase letter or number")
    expect(() => defineAgent({
      driver: codexDriver({ credentialProfile: "Support", credentials: () => "{}" }),
    })).toThrow("must start with a lowercase letter or number")
    for (const credentialProfile of ["support.", "con", "con.profile", "lpt1"]) {
      expect(() => defineAgent({
        driver: codexDriver({ credentialProfile, credentials: () => "{}" }),
      })).toThrow("must not use a Windows-equivalent path name")
    }
    expect(() => defineAgent({
      // SAFETY: This fixture deliberately supplies a string-coercible object.
      driver: codexDriver({ reasoningEffort: { toString: () => "high" } } as never),
    })).toThrow("must be a non-empty model-advertised value")
    expect(normalizeAgentDriver({ driver: codexDriver({ model: "gpt-5.6-sol", reasoningEffort: "ultra" }) })).toMatchObject({ reasoningEffort: "ultra" })
  })

  it("preserves provider environment keys that overlap object prototype accessors", () => {
    const env = { ["__proto__"]: "literal" };

    const driver = normalizeAgentDriver({ driver: codexDriver({ env }) });
    if (driver.kind !== "provider") throw new TypeError("Expected a provider driver.");
    env.__proto__ = "changed";

    expect(driver.env).toHaveProperty("__proto__", "literal");
  });

  it("accepts a sealed credential object without requiring an Env package dependency", () => {
    class SealedCredential {
      unseal() {
        return "{}"
      }
    }
    const credentials = new SealedCredential()
    const driver = normalizeAgentDriver({ driver: codexDriver({ credentials }) })

    expect(driver).toMatchObject({ credentials, kind: "provider", provider: "codex" })
  })

  it("accepts object-form Codex credential resolvers", () => {
    const credentials = { resolve: () => "{}" }
    const driver = normalizeAgentDriver({ driver: codexDriver({ credentials }) })

    expect(driver).toMatchObject({ credentials, kind: "provider", provider: "codex" })
  })

  it("normalizes static and dynamic provider launch configuration", () => {
    const environment = { resolve: () => ({ TOKEN: "selected" }) }
    const launch = { args: ["codex"], command: " provider-wrapper " }
    const driver = normalizeAgentDriver({ driver: codexDriver({ env: environment, launch }) })
    expect(driver).toMatchObject({ env: environment, kind: "provider", launch: { args: ["codex"], command: "provider-wrapper" } })
    expect(() => normalizeAgentDriver({ driver: codexDriver({ launch: { command: "" } }) }))
      .toThrow("driver.launch }) must be a command object or resolver")
    expect(() => normalizeAgentDriver({
      // SAFETY: This invalid fixture exercises provider launch normalization.
      driver: codexDriver({ launch: { args: [1], command: "wrapper" } } as never),
    })).toThrow("driver.launch.args }) must contain only strings")

    const staticAgent = defineAgent({ driver: codexDriver({ env: { TOKEN: "selected" }, launch: { command: "provider-wrapper" } }) })
    expect(createAgentInspectionMetadata(staticAgent).config?.driver.provider).toMatchObject({
      environment: "static",
      launch: "static",
    })
  })

  it.each([
    ["execution", "invalid", "driver.execution }) must be an object"],
    ["execution", { unsupported: true }, "driver.execution }) does not support option: unsupported"],
    ["execution.attachments", { attachments: "invalid" }, "driver.execution.attachments }) must be an object"],
    ["execution.attachments", { attachments: { unsupported: true } }, "driver.execution.attachments }) does not support option: unsupported"],
    ["execution.attachments.maxBytes", { attachments: { maxBytes: Number.NaN } }, "driver.execution.attachments.maxBytes }) must be a positive finite number"],
  ])("rejects invalid provider %s", (_label, execution, message) => {
    expect(() => defineAgent({
      // SAFETY: This table deliberately supplies malformed provider execution shapes to verify runtime rejection.
      driver: codexDriver({ execution } as never),
      runtime: false,
    })).toThrow(message);
  });

  it("accepts provider execution settings from another realm", () => {
    const execution = runInNewContext("({ attachments: { maxBytes: 1024 } })");

    // SAFETY: The cross-realm fixture has the provider execution shape exercised by this test.
    expect(normalizeAgentDriver({
      driver: codexDriver({ execution }),
    } as never)).toMatchObject({ execution: { attachments: { maxBytes: 1024 } } });
  });

  it("normalizes Codex credentials, reasoning, and provider settings", () => {
    const credentials = { unseal: () => "{}" };
    const providerSettings = { launchArgs: "--enable responses_websockets_v2" };
    const driver = normalizeAgentDriver({
      driver: codexDriver({
        credentialProfile: "support",
        credentials,
        model: "gpt-5.6-sol",
        providerSettings,
        reasoningEffort: "high",
        reasoningSummary: "detailed",
        sessionStorePath: " .vitehub/provider-sessions.sqlite ",
      }),
    });
    providerSettings.launchArgs = "changed";

    expect(driver).toMatchObject({
      credentialProfile: "support",
      credentials,
      kind: "provider",
      model: "gpt-5.6-sol",
      provider: "codex",
      providerSettings: { launchArgs: "--enable responses_websockets_v2" },
      reasoningEffort: "high",
      reasoningSummary: "detailed",
      sessionStorePath: ".vitehub/provider-sessions.sqlite",
    });
    const agent = defineAgent({ driver: codexDriver({
      credentialProfile: "support",
      credentials,
      env: () => ({ PROVIDER_TOKEN: "selected" }),
      launch: () => ({ command: "wrapper" }),
      model: "gpt-5.6-sol",
      providerSettings: { binaryPath: undefined, launchArgs: "--enable responses_websockets_v2" },
      reasoningEffort: "high",
      reasoningSummary: "detailed",
      sessionStorePath: ".vitehub/provider-sessions.sqlite",
    }) });
    expect(createAgentInspectionMetadata(agent).config?.driver.provider).toEqual({
      credentialProfile: "support",
      credentials: true,
      environment: "dynamic",
      launch: "dynamic",
      model: "gpt-5.6-sol",
      permissions: "ask",
      provider: "codex",
      providerSettings: ["launchArgs"],
      reasoningEffort: "high",
      reasoningSummary: "detailed",
      sessionStore: "sqlite",
    });
  });

  it("keeps a provider working directory and reports only its form", () => {
    const cwd = () => "/srv/checkout";
    expect(normalizeAgentDriver({ driver: codexDriver({ cwd: "/srv/checkout" }) })).toMatchObject({ cwd: "/srv/checkout", kind: "provider" });
    expect(normalizeAgentDriver({ driver: claudeCodeDriver({ cwd }) })).toMatchObject({ cwd, kind: "provider" });
    // SAFETY: This fixture deliberately gives a model Driver a provider-only option.
    expect(() => normalizeAgentDriver({ driver: { cwd: "/srv/checkout", model: {} } } as never)).toThrow("does not support option: cwd");
    expect(createAgentInspectionMetadata(defineAgent({ driver: codexDriver({ cwd }) })).config?.driver.provider).toMatchObject({ cwd: "dynamic" });
    expect(createAgentInspectionMetadata(defineAgent({ driver: codexDriver({ cwd: "/srv/checkout" }) })).config?.driver.provider).toMatchObject({ cwd: "static" });
  });

  it("keeps Codex workspace-write access", () => {
    expect(normalizeAgentDriver({ driver: codexDriver({ workspaceWrite: { network: true, packageCaches: true } }) }))
      .toMatchObject({ kind: "provider", workspaceWrite: { network: true, packageCaches: true } });
  });

  it("accepts sealed Codex credentials implemented by a class instance", () => {
    class SecretEnv {
      unseal() {
        return "{}";
      }
    }
    const credentials = new SecretEnv();

    expect(normalizeAgentDriver({
      driver: codexDriver({ credentials }),
    })).toMatchObject({ credentials, kind: "provider", provider: "codex" });
  });

  it.each([
    [claudeCodeDriver({ credentials: "{}" } as never), "does not support Codex option: credentials"],
    [claudeCodeDriver({ model: "claude", reasoningEffort: "high" } as never), "does not support Codex option: reasoningEffort"],
    [codexDriver({ credentials: "{}", providerSettings: { shadowHomePath: "/tmp/codex" } }), "owns the Codex shadow home"],
    [codexDriver({ credentials: "{}", sessionStorePath: ".vitehub/sessions.sqlite" }), "requires driver.credentialProfile when driver.credentials is configured"],
    [codexDriver({ reasoningEffort: "high" }), "requires driver.model"],
    [codexDriver({ model: "gpt-5.6-sol", reasoningSummary: "verbose" } as never), "must be \"auto\", \"concise\", \"detailed\", or \"none\""],
    [codexDriver({ model: "gpt-5.6-sol", reasoningSummary: { toString: (): string => "auto" } } as never), "must be \"auto\", \"concise\", \"detailed\", or \"none\""],
    [codexDriver({ providerSettings: [] } as never), "driver.providerSettings }) must be an object"],
    [codexDriver({ sessionStorePath: "" }), "driver.sessionStorePath }) must be a non-empty string"],
    [claudeCodeDriver({ sessionStorePath: {} } as never), "driver.sessionStorePath }) must be a non-empty string"],
    [codexDriver({ cwd: "" }), "driver.cwd }) must be a non-empty directory path or resolver"],
    [claudeCodeDriver({ cwd: "  " }), "driver.cwd }) must be a non-empty directory path or resolver"],
    [codexDriver({ cwd: 1 } as never), "driver.cwd }) must be a non-empty directory path or resolver"],
    [claudeCodeDriver({ workspaceWrite: { network: true } } as never), "does not support Codex option: workspaceWrite"],
    [codexDriver({ workspaceWrite: { network: "yes" } } as never), "driver.workspaceWrite }) must be an object with boolean network or packageCaches"],
    [codexDriver({ workspaceWrite: { writableRoots: ["/tmp"] } } as never), "driver.workspaceWrite }) must be an object with boolean network or packageCaches"],
  ])("rejects invalid provider options %#", (driver, message) => {
    // SAFETY: These deliberately invalid fixtures exercise the runtime normalization boundary.
    expect(() => normalizeAgentDriver({ driver } as never)).toThrow(message);
  });

  it("normalizes adaptive driver capacity defaults", () => {
    const sample = () => ({ concurrency: 2, reason: "host healthy" });

    expect(normalizeAgentDriver({
      driver: {
        capacity: {
          adaptive: { sample },
          concurrency: 4,
          queue: { maxPending: 20 },
        },
        run: () => "ok",
      },
    })).toMatchObject({
      capacity: {
        adaptive: {
          fallbackConcurrency: 1,
          intervalMs: 5_000,
          rampUp: 1,
          sample,
          sampleTimeoutMs: 1_000,
        },
        concurrency: 4,
        queue: { maxPending: 20 },
      },
    });
  });

  it.each([
    [null, "driver.capacity }) must be an object"],
    [{ concurrency: 1, unsupported: true }, "driver.capacity }) does not support option: unsupported"],
    [{ concurrency: 0 }, "driver.capacity.concurrency }) must be a positive integer"],
    [{ concurrency: 1.5 }, "driver.capacity.concurrency }) must be a positive integer"],
    [{ adaptive: null, concurrency: 1 }, "driver.capacity.adaptive }) must be an object"],
    [{ adaptive: {}, concurrency: 1 }, "driver.capacity.adaptive.sample }) must be a function"],
    [{ adaptive: { sample: "invalid" }, concurrency: 1 }, "driver.capacity.adaptive.sample }) must be a function"],
    [{ adaptive: { fallbackConcurrency: -1, sample: () => ({ concurrency: 1 }) }, concurrency: 1 }, "driver.capacity.adaptive.fallbackConcurrency }) must be an integer between zero and concurrency"],
    [{ adaptive: { fallbackConcurrency: 2, sample: () => ({ concurrency: 1 }) }, concurrency: 1 }, "driver.capacity.adaptive.fallbackConcurrency }) must be an integer between zero and concurrency"],
    [{ adaptive: { intervalMs: 99, sample: () => ({ concurrency: 1 }) }, concurrency: 1 }, "driver.capacity.adaptive.intervalMs }) must be a finite number between 100 and 2147483647"],
    [{ adaptive: { intervalMs: Number.POSITIVE_INFINITY, sample: () => ({ concurrency: 1 }) }, concurrency: 1 }, "driver.capacity.adaptive.intervalMs }) must be a finite number between 100 and 2147483647"],
    [{ adaptive: { rampUp: 0, sample: () => ({ concurrency: 1 }) }, concurrency: 1 }, "driver.capacity.adaptive.rampUp }) must be a positive integer"],
    [{ adaptive: { rampUp: 1.5, sample: () => ({ concurrency: 1 }) }, concurrency: 1 }, "driver.capacity.adaptive.rampUp }) must be a positive integer"],
    [{ adaptive: { sample: () => ({ concurrency: 1 }), sampleTimeoutMs: 0 }, concurrency: 1 }, "driver.capacity.adaptive.sampleTimeoutMs }) must be a positive finite number no greater than 2147483647"],
    [{ adaptive: { sample: () => ({ concurrency: 1 }), sampleTimeoutMs: Number.POSITIVE_INFINITY }, concurrency: 1 }, "driver.capacity.adaptive.sampleTimeoutMs }) must be a positive finite number no greater than 2147483647"],
    [{ adaptive: { sample: () => ({ concurrency: 1 }), sampleTimeoutMs: 2_147_483_648 }, concurrency: 1 }, "driver.capacity.adaptive.sampleTimeoutMs }) must be a positive finite number no greater than 2147483647"],
    [{ adaptive: { sample: () => ({ concurrency: 1 }), unsupported: true }, concurrency: 1 }, "driver.capacity.adaptive }) does not support option: unsupported"],
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
      .toThrow('defineAgent({ driver: "custom" }) is not an Agent Driver');
    // SAFETY: This fixture deliberately supplies an unknown built-in tag to verify runtime rejection.
    expect(() => defineAgent({ driver: { kind: "custom" } as never, runtime: false }))
      .toThrow('Unknown Agent Driver kind "custom"');
    expect(() => defineAgent({
      // SAFETY: This fixture deliberately combines incompatible driver fields to verify runtime rejection.
      driver: codexDriver({ run: () => "ok" } as never),
      runtime: false,
    })).toThrow("does not support option: run");
  });
});
