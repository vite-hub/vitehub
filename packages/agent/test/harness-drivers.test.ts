import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { cliproxy, cloudflare, defineAiGateway, emulate, google } from "@vite-hub/gateways"
import { acpDriver, agentWithSkills, antigravityDriver, claudeCodeDriver, codexDriver, cursorDriver, defineAgent, fxDriver, geminiDriver, grokDriver, kimiDriver, kiroDriver, museDriver, opencodeDriver, piDriver } from "../src/index.ts"
import { normalizeAgentDriver } from "../src/internal/agent-driver.ts"
import { agentDriverSessionModel, materializeAgentDriverGatewayHome, resolveAgentDriverGateway, withAgentDriverGatewayModel } from "../src/internal/agent-gateway.ts"
import { colocatedAgentSkillsSymbol } from "../src/internal/colocated-agent-skills.ts"
import { providerHarnessProfile, providerHarnessProfiles } from "../src/internal/provider-profiles.ts"
import { assertProviderSkillDelivery, materializeProviderSkills, selectProviderSkills } from "../src/internal/provider-skills.ts"
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
    ["kimi", kimiDriver(), "acp", "kimi-code"],
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

  it.each(["opencode", "pi", "kimi"] as const)("requires a model for a %s gateway", (harness) => {
    const factories = { opencode: opencodeDriver, pi: piDriver, kimi: kimiDriver }
    expect(() => normalized(factories[harness]({ gateway: gateway() }))).toThrow(`${providerHarnessProfile(harness).driverFactory}({ gateway }) needs driver.model`)
  })
})

describe("harness gateway environments", () => {
  const secret = "secret-gateway-key"
  const presets = [
    ["cliproxy", () => cliproxy({ url: "http://proxy", apiKey: secret })],
    ["google", () => google({ apiKey: secret })],
  ] as const

  async function materialized(harness: "gemini" | "kimi", gatewayValue: Parameters<typeof resolveAgentDriverGateway>[0], model: string) {
    const resolved = await resolveAgentDriverGateway(gatewayValue, harness, context, { model })
    const root = await mkdtemp(join(tmpdir(), `vitehub-${harness}-home-`))
    const home = join(root, "gateway-home")
    const result = await materializeAgentDriverGatewayHome(resolved, home)
    const files = Object.fromEntries(await Promise.all(Object.keys(resolved.home?.files ?? {}).map(async path => {
      expect((await stat(join(home, path))).mode & 0o777).toBe(0o600)
      return [path, await readFile(join(home, path), "utf8")] as const
    })))
    return { files, home, resolved: result, root }
  }

  it.each(presets)("runs Gemini CLI in a Home that selects API-key auth through %s", async (_name, preset) => {
    const { files, home, resolved, root } = await materialized("gemini", preset(), "gemini-3.8-flash-high")
    try {
      expect(Object.keys(files)).toEqual([".gemini/settings.json"])
      const settings = JSON.parse(files[".gemini/settings.json"] ?? "")
      expect(settings.security.auth.selectedType).toBe("gemini-api-key")
      expect(settings.model.name).toBe("gemini-3.8-flash-high")
      expect(resolved.environment.GEMINI_CLI_HOME).toBe(home)
      expect(resolved.environment.GEMINI_API_KEY).toBe(secret)
      expect(resolved.environment.GEMINI_API_KEY_AUTH_MECHANISM).toBe("x-goog-api-key")
      expect(resolved.environment.GOOGLE_GEMINI_BASE_URL).toBe(preset().name === "google" ? "https://generativelanguage.googleapis.com" : "http://proxy")
      expect(Object.keys(resolved.environment).sort()).toEqual(providerHarnessProfile("gemini").gateway?.ownedEnv.slice().sort())
      expect(files[".gemini/settings.json"]).not.toContain(secret)
      expect(Object.entries(resolved.environment).filter(([name]) => name !== "GEMINI_API_KEY").map(([, value]) => value).join("\n")).not.toContain(secret)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(presets)("runs Kimi Code in a Home whose provider reads the key from the environment through %s", async (_name, preset) => {
    const { files, home, resolved, root } = await materialized("kimi", preset(), "kimi-k3")
    try {
      expect(Object.keys(files)).toEqual(["config.toml"])
      const config = files["config.toml"] ?? ""
      expect(config).toContain('default_model = "vitehub/kimi-k3"')
      expect(config).toContain('[providers.vitehub]\ntype = "openai"')
      expect(config).toContain(`base_url = "${preset().name === "google" ? "https://generativelanguage.googleapis.com/v1beta/openai" : "http://proxy/v1"}"`)
      expect(config).toContain('api_key_env = "VITEHUB_GATEWAY_API_KEY"')
      expect(config).toContain('[models."vitehub/kimi-k3"]\nprovider = "vitehub"\nmodel = "kimi-k3"')
      expect(agentDriverSessionModel(resolved, "kimi-k3")).toBe("vitehub/kimi-k3")
      expect(resolved.environment).toEqual({ KIMI_CODE_CUSTOM_HEADERS: "", KIMI_CODE_HOME: home, VITEHUB_GATEWAY_API_KEY: secret })
      expect(config).not.toContain(secret)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("passes extra gateway headers to Gemini CLI and Kimi Code through the environment", async () => {
    const withHeaders = cliproxy({ url: "http://proxy", apiKey: secret, headers: { "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "secret-access" } })
    const gemini = await resolveAgentDriverGateway(withHeaders, "gemini", context, { model: "gemini-3.8-flash-high" })
    const kimi = await resolveAgentDriverGateway(withHeaders, "kimi", context, { model: "kimi-k3" })
    expect(gemini.environment.GEMINI_CLI_CUSTOM_HEADERS).toBe("CF-Access-Client-Id: id,CF-Access-Client-Secret: secret-access")
    expect(kimi.environment.KIMI_CODE_CUSTOM_HEADERS).toBe("CF-Access-Client-Id: id\nCF-Access-Client-Secret: secret-access")
    for (const resolved of [gemini, kimi]) {
      const files = Object.values(resolved.home?.files ?? {}).join("\n")
      expect(files).not.toContain(secret)
      expect(files).not.toContain("secret-access")
    }
  })

  it("rejects a Kimi x-api-key route and a Gemini bearer override before launch", () => {
    const keyGateway = defineAiGateway({ name: "key-only", apiKey: secret, auth: "x-api-key", baseURL: { "openai-compatible": "http://proxy/v1" } })
    expect(() => defineAgent({ driver: kimiDriver({ gateway: keyGateway, model: "kimi-k3", permissions: "allow-all" }) })).toThrow("Use a gateway with bearer auth")
    expect(() => defineAgent({ driver: geminiDriver({ gateway: gateway(), env: { GEMINI_API_KEY_AUTH_MECHANISM: "bearer" }, permissions: "allow-all" }) })).toThrow("GEMINI_API_KEY_AUTH_MECHANISM")
  })

  it("rejects a Gemini gateway header that the CLI would split", async () => {
    const withHeaders = cliproxy({ url: "http://proxy", apiKey: secret, headers: { "X-Test-Policy": "category: docs, region: eu" } })
    await expect(resolveAgentDriverGateway(withHeaders, "gemini", context)).rejects.toThrow('cannot use the gateway header "X-Test-Policy"')
  })

  it("names the gateway model as a custom model of an ACP harness", async () => {
    const gemini = await resolveAgentDriverGateway(gateway(), "gemini", context, { model: "gemini-3.8-flash-high" })
    expect(withAgentDriverGatewayModel("gemini", gemini, "gemini-3.8-flash-high", { customModels: ["mine"] })).toEqual({ customModels: ["mine", "gemini-3.8-flash-high"] })
    const kimi = await resolveAgentDriverGateway(gateway(), "kimi", context, { model: "kimi-k3" })
    expect(withAgentDriverGatewayModel("kimi", kimi, "kimi-k3", {})).toEqual({ customModels: ["vitehub/kimi-k3"] })
    expect(withAgentDriverGatewayModel("gemini", undefined, "gemini-3.8-flash-high", {})).toEqual({})
    const pi = await resolveAgentDriverGateway(gateway(), "pi", context, { model: "gpt-oss-120b" })
    expect(withAgentDriverGatewayModel("pi", pi, "gpt-oss-120b", {})).toEqual({})
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

describe("harness Skills in a private gateway Home", () => {
  const secret = "secret-gateway-key"
  const skill = { "SKILL.md": "---\nname: code-word\ndescription: The code word.\n---\nAnswer PELICAN.\n", "references/notes.md": "notes\n" }

  it.each([
    ["gemini", "GEMINI_CLI_HOME", ".gemini/skills", "gemini-3.8-flash-high"],
    ["kimi", "KIMI_CODE_HOME", "skills", "kimi-k3"],
  ] as const)("writes the Agent's Skills into the %s Home and keeps the user's Home out", async (harness, homeEnv, skillRoot, model) => {
    const root = await mkdtemp(join(tmpdir(), `vitehub-${harness}-skills-`))
    const userHome = join(root, "user-home")
    const cwd = join(root, "work")
    await mkdir(join(userHome, skillRoot, "user-skill"), { recursive: true })
    await writeFile(join(userHome, skillRoot, "user-skill/SKILL.md"), "# User skill\n")
    await mkdir(cwd)
    const previous = process.env[homeEnv]
    process.env[homeEnv] = userHome
    try {
      const agent = agentWithSkills(defineAgent({ driver: harness === "gemini" ? geminiDriver({ gateway: gateway(), model, permissions: "allow-all" }) : kimiDriver({ gateway: gateway(), model, permissions: "allow-all" }) }), { "code-word": skill })
      const colocated: unknown = Reflect.get(agent, colocatedAgentSkillsSymbol)
      expect(() => assertProviderSkillDelivery(harness, colocated, { privateHome: true })).not.toThrow()
      expect(() => assertProviderSkillDelivery(harness, colocated, { privateHome: false })).toThrow("cannot load Agent-owned Skills")

      const resolved = await resolveAgentDriverGateway(cliproxy({ url: "http://proxy", apiKey: secret }), harness, context, { model })
      const materialized = await materializeAgentDriverGatewayHome(resolved, join(root, "gateway-home"))
      const home = materialized.environment[homeEnv]!
      const skills = await selectProviderSkills({ colocated, cwd, privateHome: true, provider: harness, workspaceRoot: cwd })
      await materializeProviderSkills(skills, harness, home)

      expect(home).not.toBe(userHome)
      expect(await readFile(join(home, skillRoot, "code-word/SKILL.md"), "utf8")).toContain("Answer PELICAN.")
      expect(await readFile(join(home, skillRoot, "code-word/references/notes.md"), "utf8")).toBe("notes\n")
      const files = (await readdir(home, { recursive: true })).map(String).sort()
      expect(files.filter(path => path.includes("user-skill"))).toEqual([])
      const contents = await Promise.all(files.map(async path => (await stat(join(home, path))).isFile() ? await readFile(join(home, path), "utf8") : ""))
      expect(contents.join("\n")).not.toContain(secret)
    }
    finally {
      if (previous === undefined) delete process.env[homeEnv]
      else process.env[homeEnv] = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects a Skill folder without SKILL.md or with a path that leaves it", () => {
    const agent = defineAgent({ driver: geminiDriver({ permissions: "allow-all" }) })
    expect(() => agentWithSkills(agent, { review: { "notes.md": "x" } })).toThrow('Skill "review" has no SKILL.md')
    expect(() => agentWithSkills(agent, { review: { "SKILL.md": "x", "../escape.md": "x" } })).toThrow('invalid file path "../escape.md"')
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
