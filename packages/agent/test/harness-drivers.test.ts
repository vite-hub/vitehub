import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { cliproxy } from "@vite-hub/gateways"
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
    expect(() => defineAgent({ driver: opencodeDriver({ gateway: gateway(), model: "gpt-oss-120b" }) })).not.toThrow()
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

  it.each(["opencode", "pi", "kimi"] as const)("requires a model for a %s gateway", (harness) => {
    const factories = { kimi: kimiDriver, opencode: opencodeDriver, pi: piDriver }
    expect(() => normalized(factories[harness]({ gateway: gateway() }))).toThrow(`${providerHarnessProfile(harness).driverFactory}({ gateway }) needs driver.model`)
  })
})

describe("harness gateway environments", () => {
  it("sends Gemini CLI to the gemini route and selects the model in its environment", async () => {
    const resolved = await resolveAgentDriverGateway(cliproxy({ url: "http://proxy", apiKey: "k", headers: { "X-Team": "a" } }), "gemini", context, { model: "gemini-x" })
    expect(resolved.environment).toEqual({ GOOGLE_GEMINI_BASE_URL: "http://proxy", GEMINI_API_KEY: "k", GEMINI_CLI_CUSTOM_HEADERS: "X-Team: a", GEMINI_MODEL: "gemini-x" })
    expect(agentDriverSessionModel(resolved, "gemini-x")).toBeUndefined()
    expect(resolved.home).toBeUndefined()
  })

  it("sends Kimi to the OpenAI-compatible route with its model", async () => {
    const resolved = await resolveAgentDriverGateway(gateway(), "kimi", context, { model: "kimi-k3" })
    expect(resolved.environment).toEqual({ KIMI_BASE_URL: "http://proxy/v1", KIMI_API_KEY: "k", KIMI_MODEL_NAME: "kimi-k3" })
    expect(agentDriverSessionModel(resolved, "kimi-k3")).toBeUndefined()
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
  })
})
