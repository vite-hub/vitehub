import { readFile } from "node:fs/promises"
import { chatgpt, defineAiGateway } from "@vite-hub/gateways"
import { sshLaunch } from "@vite-hub/sandbox/ssh"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

const providerRuntimes = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const createProviderRuntime = vi.hoisted(() => vi.fn(async (_options: { environment?: Record<string, string>, settings?: Record<string, unknown> }) => providerRuntimes.shift()))
const seen: { catalog?: string } = {}
vi.mock("@t3tools/provider-runtime", () => ({ createProviderRuntime, createSqliteProviderRuntimeSessionStore: vi.fn() }))
vi.mock("#vitehub/agent/registry", () => ({ default: {}, loadAgentHost: async () => {} }))
vi.mock("../src/internal/provider-runtime-packages.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../src/internal/provider-runtime-packages.ts")>(),
  resolveInstalledProviderExecutable: () => "/app/node_modules/@openai/codex/bin/codex.js",
}))

import { codexDriver, defineAgent, defineCapability } from "../src/index.ts"
import { createProviderAgentAdapter } from "../src/provider-agent.ts"
import { runAgentWithContext } from "../src/internal/agent-run.ts"
import { installAgentServerEnv } from "../src/internal/builtin-env.ts"
import { codexConfigArg } from "../src/internal/codex-launch-args.ts"

// A credential read fails the test: an emulated run must not read a key, a Codex sign-in, or a ChatGPT grant.
const credentialRead = (what: string) => new Error(`An emulated run read the credential ${what}.`)
const secretNames = /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN)$/
const originalEnv = process.env
const emulatorUrl = "http://127.0.0.1:4999"
const realGateway = defineAiGateway({ name: "real", apiKey: () => { throw credentialRead("gateway apiKey") }, baseURL: { "codex": "https://real.example/v1", "claude-code": "https://real.example" } })
const credentials = () => { throw credentialRead("driver.credentials") }

beforeEach(() => {
  const env = Object.fromEntries(Object.entries(originalEnv).filter(([name]) => !secretNames.test(name)))
  process.env = new Proxy(env, {
    get(target, name) {
      if (typeof name === "string" && secretNames.test(name)) throw credentialRead(name)
      return Reflect.get(target, name)
    },
  })
  vi.stubEnv("VITEHUB_MODELS", "emulate")
  vi.stubEnv("VITEHUB_EMULATE_URL", emulatorUrl)
  vi.stubEnv("CODEX_HOME", "/home/developer/.codex")
  createProviderRuntime.mockClear()
})

afterEach(() => {
  installAgentServerEnv(undefined)
  vi.unstubAllEnvs()
  process.env = originalEnv
  providerRuntimes.length = 0
})

function providerRuntime(fixedThreadId?: string) {
  // runAgent() picks the thread ID, so the events use the one that the run starts.
  let threadId = fixedThreadId ?? ""
  providerRuntimes.push({
    attachmentsDirectory: `/tmp/attachments-${crypto.randomUUID()}`,
    close: vi.fn(async () => undefined),
    events: {
      async *[Symbol.asyncIterator]() {
        yield { payload: { itemType: "assistant_message", delta: "Emulated." }, threadId, turnId: "turn-1", itemId: "item-1", type: "content.delta" }
        yield { payload: { state: "completed" }, threadId, turnId: "turn-1", type: "turn.completed" }
      },
    },
    interruptTurn: vi.fn(async () => undefined),
    respondToRequest: vi.fn(async () => undefined),
    respondToUserInput: vi.fn(async () => undefined),
    sendTurn: vi.fn(async () => {
      // The run removes its temporary root after the turn. Read the model catalog while Codex would read it.
      const path = /model_catalog_json=\\"([^"\\]+)\\"/.exec(String(createProviderRuntime.mock.lastCall?.[0].settings?.launchArgs))?.[1]
      seen.catalog = path ? await readFile(path, "utf8") : undefined
      return { threadId, turnId: "turn-1" }
    }),
    startSession: vi.fn(async (input: { threadId: string }) => {
      threadId ||= input.threadId
      return { threadId }
    }),
    stopSession: vi.fn(async () => undefined),
  })
}

function context(threadId: string, overrides: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>()
  return {
    context: {
      entries: () => values.entries(),
      get: (key: string) => values.get(key),
      has: (key: string) => values.has(key),
      set: (key: string, value: unknown) => values.set(key, value),
      toJSON: () => Object.fromEntries(values),
    },
    input: { prompt: "Hello" },
    invoker: { id: "invoker", kind: "user" },
    messages: [],
    prompt: "Hello",
    runtime: { memo: <T>(_key: string, create: () => T) => create(), run: { runId: `run-${threadId}`, threadId }, runtime: "vite", runtimeConfig: {}, waitUntil: () => undefined },
    ...overrides,
  }
}

describe("provider Drivers with VITEHUB_MODELS=emulate", () => {
  it("launches Codex without tools on the emulator and reads no credential", async () => {
    providerRuntime("codex-emulated")
    const env = vi.fn(() => ({ HOME: "/home/developer" }))
    await createProviderAgentAdapter({
      provider: "codex",
      model: "gpt-5.5",
      credentials,
      gateway: realGateway,
      env,
      providerSettings: { launchArgs: '-c model_provider="openai"', homePath: "/home/developer/.codex", shadowHomePath: "/home/developer/.codex-shadow" },
    }).generate(context("codex-emulated") as never)

    const options = createProviderRuntime.mock.lastCall?.[0]
    const launchArgs = String(options?.settings?.launchArgs)
    expect(launchArgs).toContain(codexConfigArg("model_provider", '"vitehub"'))
    expect(launchArgs).toContain(codexConfigArg("model_providers.vitehub.base_url", JSON.stringify(`${emulatorUrl}/v1`)))
    expect(launchArgs).toContain(codexConfigArg("model_providers.vitehub.name", '"emulate"'))
    for (const value of ['web_search="disabled"', "mcp_servers={}"]) {
      expect(launchArgs).toContain(codexConfigArg(value.slice(0, value.indexOf("=")), value.slice(value.indexOf("=") + 1)))
    }
    for (const feature of ["multi_agent", "multi_agent_v2", "goals", "apps", "plugins"]) expect(launchArgs).toContain(`--disable ${feature}`)
    // Codex applies the last override, so the emulator wins over a model provider in providerSettings.launchArgs.
    expect(launchArgs.lastIndexOf("model_provider=")).toBeGreaterThan(launchArgs.indexOf('model_provider="openai"'))
    expect(JSON.parse(seen.catalog ?? "{}")).toMatchObject({ models: [{ slug: "vitehub-emulator", visibility: "hide" }] })
    expect(seen.catalog).not.toContain("apply_patch_tool_type")

    expect(options?.environment?.VITEHUB_GATEWAY_API_KEY).toBe("emulate")
    expect(options?.environment?.CODEX_HOME).toMatch(/codex-home$/)
    expect(options?.environment?.CODEX_HOME).not.toBe("/home/developer/.codex")
    expect(options?.settings?.homePath).toBe(options?.environment?.CODEX_HOME)
    expect(options?.settings).not.toHaveProperty("shadowHomePath")
    expect(env).toHaveBeenCalledOnce()
  })

  it("sends a Codex Agent on the ChatGPT plan to the emulator without a ChatGPT grant", async () => {
    providerRuntime("codex-chatgpt-emulated")
    await createProviderAgentAdapter({ provider: "codex", model: "gpt-5.5", gateway: chatgpt() }).generate(context("codex-chatgpt-emulated") as never)
    const launchArgs = String(createProviderRuntime.mock.lastCall?.[0].settings?.launchArgs)
    expect(launchArgs).toContain(codexConfigArg("model_providers.vitehub.base_url", JSON.stringify(`${emulatorUrl}/v1`)))
    expect(launchArgs).not.toContain("openai_chatgpt_plan")
  })

  it.each([
    ["a disconnected ChatGPT Connection", () => ({ gateway: chatgpt() })],
    ["driver.credentials", (spy: () => never) => ({ credentials: spy })],
    ["a gateway key", (spy: () => never) => ({ gateway: defineAiGateway({ name: "real", apiKey: spy, baseURL: { codex: "https://real.example/v1" } }) })],
  ])("runs through runAgent() with %s and probes no provider", async (_name, driver) => {
    providerRuntime()
    const read = vi.fn((): never => { throw credentialRead("a provider credential") })
    const inspect = vi.fn(async () => ({ status: "disconnected", chatgpt: { hostId: "urn:uuid:host", plan: "disabled" } }))
    const useChatGPTCredential = vi.fn(read)
    const agent = defineAgent({
      name: "emulated",
      runtime: false,
      // A Capability with a prepare hook makes the Invocation check provider readiness first.
      capabilities: [defineCapability({ id: "setup", prepare: vi.fn() })],
      driver: codexDriver({ model: "gpt-5.5", ...driver(read) }),
    })
    const host = {
      runtime: "vite" as const,
      memo: <T>(_key: string, create: () => T) => create(),
      waitUntil: () => undefined,
      capabilities: { connections: { runtime: () => ({ inspect }), useChatGPTCredential } },
    }
    await expect(runAgentWithContext(agent, host, { prompt: "Hello" })).resolves.toMatchObject({ finishReason: "completed" })
    expect(read).not.toHaveBeenCalled()
    expect(inspect).not.toHaveBeenCalled()
    expect(useChatGPTCredential).not.toHaveBeenCalled()
    expect(String(createProviderRuntime.mock.lastCall?.[0].settings?.launchArgs)).toContain(codexConfigArg("model_providers.vitehub.base_url", JSON.stringify(`${emulatorUrl}/v1`)))
  })

  it("reads only VITEHUB_EMULATE_URL when another Server Env value is required and unset", async () => {
    providerRuntime("codex-server-env")
    installAgentServerEnv({ useServerEnv: () => { throw Object.assign(new Error("ENV_REQUIRED_MISSING: env.server.codex.auth is required."), { code: "ENV_REQUIRED_MISSING" }) } })
    await createProviderAgentAdapter({ provider: "codex", model: "gpt-5.5" }).generate(context("codex-server-env") as never)
    expect(String(createProviderRuntime.mock.lastCall?.[0].settings?.launchArgs)).toContain(codexConfigArg("model_providers.vitehub.base_url", JSON.stringify(`${emulatorUrl}/v1`)))
  })

  it("keeps compatible caller launch options and turns off the ones that send namespace tools", async () => {
    providerRuntime("codex-launch-args")
    await createProviderAgentAdapter({
      provider: "codex",
      model: "gpt-5.5",
      env: { T3CODE_CODEX_LAUNCH_ARGS: "-c hide_agent_reasoning=true --enable multi_agent" },
      providerSettings: { launchArgs: "-c features.multi_agent_v2=true" },
    }).generate(context("codex-launch-args") as never)

    const options = createProviderRuntime.mock.lastCall?.[0]
    const launchArgs = String(options?.settings?.launchArgs)
    // The runtime prefers T3CODE_CODEX_LAUNCH_ARGS over settings, so both carry the complete list.
    expect(options?.environment?.T3CODE_CODEX_LAUNCH_ARGS).toBe(launchArgs)
    expect(launchArgs).toContain("-c hide_agent_reasoning=true")
    // Codex applies `--disable` over `--enable` and `-c features.<name>=true`.
    expect(launchArgs.indexOf("--disable multi_agent ")).toBeGreaterThan(launchArgs.indexOf("--enable multi_agent"))
    expect(launchArgs).toContain("--disable multi_agent_v2")
  })

  it("forwards the emulator Codex Home through a launcher that forwards only required names", async () => {
    providerRuntime("codex-ssh")
    let forwarded: string[] = []
    await createProviderAgentAdapter({
      provider: "codex",
      model: "gpt-5.5",
      launch: (launchContext) => {
        const { command, args } = sshLaunch({ host: "127.0.0.1", user: "agent", identityFile: "/dev/null", forwardEnvironment: [] })(launchContext)
        forwarded = (JSON.parse(args.at(-1)!) as { forwardEnvironment: string[] }).forwardEnvironment
        return { command, args }
      },
    }).generate(context("codex-ssh") as never)
    expect(forwarded).toContain("CODEX_HOME")
    expect(forwarded).toContain("VITEHUB_GATEWAY_API_KEY")
  })

  it.each([
    ["Claude Code", { provider: "claude-code" as const }, {}, "AGENT_MODELS_EMULATE_CLAUDE_CODE_UNSUPPORTED"],
    ["Codex with Capability tools", { provider: "codex" as const, credentials }, { tools: { "release:check": { execute: async () => "ok", inputSchema: z.object({}) } } }, "AGENT_MODELS_EMULATE_CODEX_TOOLS_UNSUPPORTED"],
    ["Codex in a Sandbox", { provider: "codex" as const, credentials, sandbox: { provider: "docker" } as never }, {}, "AGENT_MODELS_EMULATE_SANDBOX_UNSUPPORTED"],
  ])("fails closed for %s before it reads a credential or starts the provider", async (_name, driver, overrides, code) => {
    const env = vi.fn(() => { throw credentialRead("driver.env") })
    await expect(createProviderAgentAdapter({ ...driver, env, gateway: realGateway }).generate(context(`fail-${code}`, overrides) as never)).rejects.toMatchObject({ code })
    expect(env).not.toHaveBeenCalled()
    expect(createProviderRuntime).not.toHaveBeenCalled()
  })
})
