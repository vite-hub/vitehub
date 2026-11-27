import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { cliproxy, cloudflare, emulate } from "@vite-hub/gateways"
import { acpDriver, antigravityDriver, claudeCodeDriver, codexDriver, cursorDriver, defineAgent, fxDriver, geminiDriver, grokDriver, kimiDriver, kiroDriver, museDriver, opencodeDriver, piDriver } from "../src/index.ts"
import { normalizeAgentDriver } from "../src/internal/agent-driver.ts"
import { agentDriverSessionModel, materializeAgentDriverGatewayHome, resolveAgentDriverGateway } from "../src/internal/agent-gateway.ts"
import { providerHarnessProfile, providerHarnessProfiles } from "../src/internal/provider-profiles.ts"
import { providerRuntimeSettings } from "../src/provider-agent.ts"

const context = { purpose: "inspection" } as never
const gateway = () => cliproxy({ url: "http://proxy", apiKey: "k" })

function normalized(driver: unknown) {
  // SAFETY: The fixture passes factory output, which is the driver contract normalization validates.
  return normalizeAgentDriver({ driver } as never)
}

describe("harness drivers", () => {
  it.each([
    ["codex", codexDriver(), "codex", undefined],
    ["claude-code", claudeCodeDriver(), "claude-code", undefined],
    ["gemini", geminiDriver(), "acp", "gemini"],
    ["antigravity", antigravityDriver(), "antigravity", undefined],
    ["opencode", opencodeDriver(), "opencode", undefined],
    ["cursor", cursorDriver(), "cursor", undefined],
    ["grok", grokDriver(), "grok", undefined],
    ["pi", piDriver(), "pi", undefined],
    ["kimi", kimiDriver(), "acp", "kimi"],
    ["kiro", kiroDriver(), "kiro", undefined],
    ["fx", fxDriver(), "fx", undefined],
    ["muse", museDriver(), "muse", undefined],
  ] as const)("builds the %s driver on its runtime kind", (harness, driver, runtimeKind, agentId) => {
    expect(driver.kind).toBe(harness)
    expect(normalized(driver)).toMatchObject({ kind: "provider", provider: harness })
    expect(providerHarnessProfile(harness).runtimeKind).toBe(runtimeKind)
    expect(providerHarnessProfile(harness).agentId).toBe(agentId)
  })

  it("profiles every gateway harness id", () => {
    expect(Object.keys(providerHarnessProfiles).sort()).toEqual(["acp", "antigravity", "claude-code", "codex", "cursor", "fx", "gemini", "grok", "kimi", "kiro", "muse", "opencode", "pi"])
  })

  it("runs a generic ACP agent by its registry id", () => {
    const driver = acpDriver({ agentId: "cline" })
    expect(driver.kind).toBe("acp")
    expect(providerHarnessProfile("acp").runtimeKind).toBe("acp")
    expect(normalized(driver)).toMatchObject({ kind: "provider", provider: "acp", agentId: "cline" })
    expect(() => normalized(acpDriver({ agentId: "Not Valid" }))).toThrow("acpDriver({ agentId }) needs the agent's id")
    expect(() => normalized({ ...geminiDriver(), agentId: "cline" })).toThrow('kind: "gemini" } }) does not take agentId')
  })

  it("accepts a driver in defineAgent", () => {
    expect(() => defineAgent({ driver: opencodeDriver({ gateway: gateway(), model: "gpt-oss-120b", permissions: "allow-all" }) })).not.toThrow()
  })

  it.each([cursorDriver(), geminiDriver(), acpDriver({ agentId: "cline" })])("rejects the default approval mode for $kind", (driver) => {
    expect(() => defineAgent({ driver })).toThrow("does not enforce driver.permissions")
  })

  it.each([cursorDriver(), opencodeDriver(), piDriver(), acpDriver({ agentId: "cline" })])("rejects an unsupported Sandbox for $kind", (driver) => {
    expect(() => defineAgent({ driver, sandbox: { runtime: "trusted-host" } })).toThrow("does not support Sandbox execution")
  })

  it("rejects a Cursor launch wrapper", () => {
    expect(() => defineAgent({ driver: cursorDriver({ launch: { command: "wrapper" }, permissions: "allow-all" }) })).toThrow("cannot honor driver.launch")
  })

  it.each([cloudflare(), emulate()])("rejects SDK-only gateway $name through defineAgent", (gateway) => {
    expect(() => defineAgent({ driver: opencodeDriver({ gateway, model: "example", permissions: "allow-all" }) })).toThrow("does not serve the opencode Driver")
  })

  it("rejects a gateway configured for an attached OpenCode server", () => {
    expect(() => defineAgent({ driver: opencodeDriver({ gateway: gateway(), model: "example", permissions: "allow-all", providerSettings: { serverUrl: "http://localhost:4000" } }) })).toThrow("cannot apply driver.gateway to an attached server")
  })

  it.each([
    ["antigravity", () => antigravityDriver({ gateway: gateway() } as never)],
    ["cursor", () => cursorDriver({ gateway: gateway() } as never)],
    ["grok", () => grokDriver({ gateway: gateway() } as never)],
    ["kiro", () => kiroDriver({ gateway: gateway() } as never)],
    ["fx", () => fxDriver({ gateway: gateway() } as never)],
    ["muse", () => museDriver({ gateway: gateway() } as never)],
    ["acp", () => acpDriver({ agentId: "cline", gateway: gateway() } as never)],
  ] as const)("rejects a gateway on the sign-in-only %s driver", (harness, driver) => {
    const profile = providerHarnessProfile(harness)
    expect(profile.signInOnly).toBe(true)
    expect(() => normalized(driver())).toThrow(`${profile.displayName} signs in to its own service, so no gateway serves the ${harness} Driver. Remove driver.gateway`)
  })

  it.each(["opencode", "pi"] as const)("requires a model for a %s gateway", (harness) => {
    const factories = { opencode: opencodeDriver, pi: piDriver }
    expect(() => normalized(factories[harness]({ gateway: gateway() }))).toThrow(`${providerHarnessProfile(harness).driverFactory}({ gateway }) needs driver.model`)
  })
})

describe("harness gateway environments", () => {
  it.each([["gemini", geminiDriver], ["kimi", kimiDriver]] as const)("rejects a %s gateway before reading its credentials", async (harness, driver) => {
    const apiKey = vi.fn(() => "not-read")
    const gateway = cliproxy({ url: "http://proxy", apiKey })
    expect(() => defineAgent({ driver: driver({ gateway, permissions: "allow-all" } as never) })).toThrow("cannot isolate gateway credentials")
    await expect(resolveAgentDriverGateway(gateway, harness, context)).rejects.toThrow("cannot isolate gateway credentials")
    expect(apiKey).not.toHaveBeenCalled()
  })

  it("configures an OpenCode provider without writing the key into the config", async () => {
    const resolved = await resolveAgentDriverGateway(gateway(), "opencode", context, { model: "gpt-oss-120b" })
    expect(agentDriverSessionModel(resolved, "gpt-oss-120b")).toBe("vitehub/gpt-oss-120b")
    expect(resolved.environment.VITEHUB_GATEWAY_API_KEY).toBe("k")
    const config = JSON.parse(resolved.environment.OPENCODE_CONFIG_CONTENT ?? "")
    expect(config.model).toBe("vitehub/gpt-oss-120b")
    expect(config.provider.vitehub).toMatchObject({
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://proxy/v1", apiKey: "{env:VITEHUB_GATEWAY_API_KEY}" },
      models: { "gpt-oss-120b": {} },
    })
    expect(resolved.environment.OPENCODE_CONFIG_CONTENT).not.toContain("\"k\"")
  })

  it("writes a private Pi models.json home", async () => {
    const resolved = await resolveAgentDriverGateway(gateway(), "pi", context, { model: "gpt-oss-120b" })
    expect(resolved.model).toBe("vitehub/gpt-oss-120b")
    expect(resolved.environment).toEqual({ VITEHUB_GATEWAY_API_KEY: "k" })
    const root = await mkdtemp(join(tmpdir(), "vitehub-pi-home-"))
    try {
      const home = join(root, "gateway-home")
      const materialized = await materializeAgentDriverGatewayHome(resolved, home)
      expect(materialized.environment.PI_CODING_AGENT_DIR).toBe(home)
      const models = JSON.parse(await readFile(join(home, "models.json"), "utf8"))
      expect(models.providers.vitehub).toMatchObject({ baseUrl: "http://proxy/v1", api: "openai-completions", apiKey: "$VITEHUB_GATEWAY_API_KEY", models: [{ id: "gpt-oss-120b" }] })
      expect((await stat(join(home, "models.json"))).mode & 0o777).toBe(0o600)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("harness runtime settings", () => {
  it("keeps Codex and Claude Code settings unchanged", () => {
    const settings = { binaryPath: "/bin/codex", homePath: "/home" }
    expect(providerRuntimeSettings("codex", undefined, settings)).toBe(settings)
    expect(providerRuntimeSettings("claude-code", undefined, settings)).toBe(settings)
  })

  it("enables runtimes that are off by default", () => {
    expect(providerRuntimeSettings("opencode", undefined, { binaryPath: "/bin/opencode" })).toEqual({ enabled: true, binaryPath: "/bin/opencode" })
    expect(providerRuntimeSettings("muse", undefined, {})).toEqual({ enabled: true })
  })

  it("runs ACP harnesses from the registry with a local command", () => {
    expect(providerRuntimeSettings("gemini", undefined, { binaryPath: "/bin/gemini", launchArgs: "--x" })).toEqual({ enabled: true, source: "registry", agentId: "gemini", commandPath: "/bin/gemini" })
    expect(providerRuntimeSettings("acp", "cline", {})).toEqual({ enabled: true, source: "registry", agentId: "cline" })
    expect(providerRuntimeSettings("gemini", undefined, { source: "custom", agentId: "cline" })).toMatchObject({ source: "registry", agentId: "gemini" })
    expect(providerRuntimeSettings("acp", "cline", { agentId: "gemini" })).toMatchObject({ source: "registry", agentId: "cline" })
  })
})
