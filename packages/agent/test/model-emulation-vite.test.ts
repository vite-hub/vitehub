import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { createServer, createServerHotChannel, DevEnvironment, resolveConfig } from "vite"
import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from "vitest"

import { defineAgent, runAgent } from "../src/index.ts"
import { hubAgent } from "../src/vite.ts"

import type { InlineConfig, ViteDevServer, WebSocketServer } from "vite"
import type { EmulatedModelSeed } from "../src/test/emulate-models.ts"
import type { AgentModelsEmulateSeed, AgentModelsOptions, AgentOptions } from "../src/types.ts"

const names = ["VITEHUB_MODELS", "VITEHUB_EMULATE_URL"] as const
const roots: string[] = []
const servers: ViteDevServer[] = []

beforeEach(() => {
  for (const name of names) vi.stubEnv(name, undefined)
  // Without the emulator, a model run needs a real provider: it has no key, and the gateway override cannot connect.
  vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
  vi.stubEnv("EMULATE_BASE_URL", "http://localhost:9")
})

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
  vi.doUnmock("@emulators/ai")
  vi.doUnmock("../src/internal/ai-emulator.ts")
  vi.resetModules()
})

type WranglerVars = { vars?: Record<string, unknown> }
type Wrangler = WranglerVars & { env?: Record<string, WranglerVars> }
type Nitro = { options: { dev: boolean, devServer: { runner?: string }, cloudflare?: { wranglerEnv?: string, wrangler?: Wrangler } } }

/** The runner that Nitro's miniflare dev server uses, from Nitro's own dependencies. */
interface MiniflareRunner {
  waitForReady: (timeout?: number) => Promise<void>
  fetch: (input: string) => Promise<Response>
  close: () => Promise<void>
}
type MiniflareRunnerClass = new (options: { name: string, data: { entry: string }, miniflare: unknown, wrangler: Wrangler, wranglerEnv?: string, wranglerModule: string }) => MiniflareRunner

/** Runs a Worker in Miniflare with the inline Wrangler config, as Nitro's miniflare dev runner does, and returns its env values. */
async function workerEnv(root: string, wrangler: Wrangler, wranglerEnv?: string): Promise<Record<string, unknown>> {
  const nitroRequire = createRequire(createRequire(import.meta.url).resolve("nitro/package.json"))
  // SAFETY: env-runner is a dependency of Nitro, not of this package, so its types are not in scope here.
  const { MiniflareEnvRunner } = await import(pathToFileURL(nitroRequire.resolve("env-runner/runners/miniflare")).href) as { MiniflareEnvRunner: MiniflareRunnerClass }
  const entry = join(root, "worker.mjs")
  await writeFile(entry, "export default { fetch: (request, env) => Response.json({ VITEHUB_MODELS: env.VITEHUB_MODELS, VITEHUB_EMULATE_URL: env.VITEHUB_EMULATE_URL, TOP: env.TOP, LOCAL: env.LOCAL }) }\n")
  const runner = new MiniflareEnvRunner({ name: "model-emulation", data: { entry }, miniflare: await import("miniflare"), wrangler, wranglerEnv, wranglerModule: "wrangler" })
  try {
    await runner.waitForReady(30_000)
    return await (await runner.fetch("http://localhost/")).json() as Record<string, unknown>
  }
  finally {
    await runner.close()
  }
}

async function app(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-model-emulation-vite-"))
  roots.push(root)
  return root
}

function inline(root: string, plugin: ReturnType<typeof hubAgent>, info = vi.fn<(message: string) => void>()): InlineConfig {
  const logger = { info, warn: () => {}, warnOnce: () => {}, error: () => {}, clearScreen: () => {}, hasErrorLogged: () => false, hasWarned: false }
  return { root, configFile: false, appType: "custom", customLogger: logger, plugins: [plugin], server: { middlewareMode: true, watch: null } }
}

function isAgentOptions(value: AgentModelsOptions["emulate"] | AgentOptions): value is AgentOptions {
  return typeof value === "object" && !("rules" in value)
}

/** A real dev server with an inline plugin, so `server.restart()` reuses the plugin instance, as `createServer()` callers do. */
async function devServer(emulate: AgentModelsOptions["emulate"] | AgentOptions, root?: string) {
  const info = vi.fn<(message: string) => void>()
  const plugin = hubAgent(isAgentOptions(emulate) ? emulate : { models: { emulate } })
  const server = await createServer(inline(root ?? await app(), plugin, info))
  servers.push(server)
  const close = async () => {
    servers.splice(servers.indexOf(server), 1)
    await server.close()
  }
  return { server, info, close }
}

async function ask(url: string, prompt: string): Promise<string> {
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "emulated", messages: [{ role: "user", content: prompt }] }),
  })
  const body = await response.json() as { choices: Array<{ message: { content: string } }> }
  return body.choices[0]!.message.content
}

/** An Invocation of a model Driver Agent, as the dev runtime runs it. It reads the switch from process.env. */
async function invoke(prompt: string): Promise<string | undefined> {
  const agent = defineAgent({ runtime: false, driver: { model: "openai/gpt-5.1" } })
  const [error, result] = await runAgent(agent, { prompt })
  if (error) throw error
  return result.text
}

function reply(id: string, text: string): AgentModelsEmulateSeed {
  return { rules: [{ id, match: { textContains: "hello" }, reply: [{ type: "text", text }] }] }
}

const hello = reply("hello", "Hi from the rule.")

it("starts the AI emulator with a dev server, sets the switch, and stops it when the server closes", async () => {
  const { info, close } = await devServer(hello)
  const url = process.env.VITEHUB_EMULATE_URL!
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  expect(process.env.VITEHUB_MODELS).toBe("emulate")
  expect(info.mock.calls.filter(([message]) => message.includes(url))).toHaveLength(1)
  expect(await invoke("hello there")).toBe("Hi from the rule.")

  await close()
  expect(process.env.VITEHUB_MODELS).toBeUndefined()
  expect(process.env.VITEHUB_EMULATE_URL).toBeUndefined()
  await expect(fetch(`${url}/_ai/rules`)).rejects.toThrow()
}, 30_000)

it("restores the values that the shell set", async () => {
  vi.stubEnv("VITEHUB_EMULATE_URL", "http://127.0.0.1:4014")
  const { close } = await devServer(true)
  expect(process.env.VITEHUB_EMULATE_URL).not.toBe("http://127.0.0.1:4014")
  await close()
  expect(process.env.VITEHUB_EMULATE_URL).toBe("http://127.0.0.1:4014")
  expect(process.env.VITEHUB_MODELS).toBeUndefined()
}, 30_000)

it("keeps the emulator of a dev server across a real restart with an inline plugin", async () => {
  const { server } = await devServer(hello)
  const url = process.env.VITEHUB_EMULATE_URL!
  await server.restart()
  expect(process.env.VITEHUB_MODELS).toBe("emulate")
  expect(process.env.VITEHUB_EMULATE_URL).toBe(url)
  expect(await invoke("hello after the restart")).toBe("Hi from the rule.")

  await server.close()
  expect(process.env.VITEHUB_MODELS).toBeUndefined()
  await expect(fetch(`${url}/_ai/rules`)).rejects.toThrow()
}, 60_000)

it("replaces the rules and the reset seed when a restart changes them", async () => {
  const options = { models: { emulate: reply("first", "Reply A.") } }
  const { server, info } = await devServer(options)
  const url = process.env.VITEHUB_EMULATE_URL!
  options.models.emulate = { rules: [{ id: "second", match: { textContains: "hello" }, times: 1, reply: [{ type: "text", text: "Reply B." }] }, { id: "fallback", match: {}, reply: [{ type: "text", text: "Budget used." }] }] }
  await server.restart()
  expect(process.env.VITEHUB_EMULATE_URL).toBe(url)
  expect(info.mock.calls.some(([message]) => message.includes("rules of agent.models.emulate changed"))).toBe(true)
  expect(await invoke("hello")).toBe("Reply B.")
  expect(await invoke("hello")).toBe("Budget used.")

  expect((await fetch(`${url}/_ai/reset`, { method: "POST" })).ok).toBe(true)
  expect(await ask(url, "hello")).toBe("Reply B.")

  // A second restart with the same seed changes nothing.
  await server.restart()
  expect(await ask(url, "hello")).toBe("Budget used.")
}, 60_000)

it("starts a new emulator on a new port after a full stop", async () => {
  const root = await app()
  const first = await devServer(true, root)
  const url = process.env.VITEHUB_EMULATE_URL!
  await first.close()
  await devServer(true, root)
  expect(process.env.VITEHUB_EMULATE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  expect(process.env.VITEHUB_EMULATE_URL).not.toBe(url)
}, 30_000)

it("shares one emulator between apps with the same setting until the last one closes", async () => {
  const first = await devServer(hello)
  const url = process.env.VITEHUB_EMULATE_URL!
  const second = await devServer(hello)
  expect(process.env.VITEHUB_EMULATE_URL).toBe(url)
  await first.close()
  expect(await invoke("hello")).toBe("Hi from the rule.")
  await second.close()
  expect(process.env.VITEHUB_MODELS).toBeUndefined()
}, 30_000)

it("shares one emulator between apps whose seeds differ only in key order", async () => {
  const rules = [{ id: "hello", match: { textContains: "hello" }, reply: [{ type: "text", text: "Hi from the rule." }] }]
  await devServer({ rules, strict: true })
  const url = process.env.VITEHUB_EMULATE_URL!
  await devServer({ strict: true, rules: [{ reply: [{ text: "Hi from the rule.", type: "text" }], match: { textContains: "hello" }, id: "hello" }] })
  expect(process.env.VITEHUB_EMULATE_URL).toBe(url)
  expect(await invoke("hello")).toBe("Hi from the rule.")
}, 30_000)

it.each([
  { name: "an app without emulate after an emulating app", first: hello, second: undefined },
  { name: "an emulating app after an app without emulate", first: undefined, second: hello },
  { name: "an app with another seed", first: hello, second: reply("other", "Another app.") },
])("refuses $name in the same process", async ({ first, second }) => {
  await devServer(first)
  const url = process.env.VITEHUB_EMULATE_URL
  await expect(devServer(second)).rejects.toMatchObject({ code: "AGENT_EMULATOR_DEV_APPS_CONFLICT" })
  expect(process.env.VITEHUB_EMULATE_URL).toBe(url)
  if (url) expect(await invoke("hello")).toBe("Hi from the rule.")
  else expect(process.env.VITEHUB_MODELS).toBeUndefined()
}, 30_000)

it.each([
  { name: "the default Wrangler environment", wranglerEnv: undefined, shell: undefined, kept: { TOP: "1" } },
  { name: "the named environment of Nitro's wranglerEnv", wranglerEnv: "local", shell: undefined, kept: { LOCAL: "1" } },
  { name: "the named environment of CLOUDFLARE_ENV", wranglerEnv: undefined, shell: "local", kept: { LOCAL: "1" } },
])("gives the switch to a miniflare dev Worker in $name", async ({ wranglerEnv, shell, kept }) => {
  vi.stubEnv("CLOUDFLARE_ENV", shell)
  const plugin = hubAgent({ models: { emulate: true } })
  const wrangler: Wrangler = { vars: { TOP: "1" }, env: { local: { vars: { LOCAL: "1" } } } }
  const nitro: Nitro = { options: { dev: true, devServer: { runner: "miniflare" }, cloudflare: { wranglerEnv, wrangler } } }
  plugin.nitro!.setup(nitro as never)
  const root = await app()
  servers.push(await createServer(inline(root, plugin)))
  const env = await workerEnv(root, wrangler, wranglerEnv)
  expect(env).toMatchObject({ ...kept, VITEHUB_MODELS: "emulate", VITEHUB_EMULATE_URL: process.env.VITEHUB_EMULATE_URL })
}, 60_000)

it.each(["serve", "build"] as const)("does not start or validate the emulator when only a %s config resolves", async (command) => {
  // SAFETY: The rule is invalid on purpose, so a start or a validation would throw.
  const plugin = hubAgent({ models: { emulate: { rules: [{ id: "broken" }] } as unknown as AgentModelsEmulateSeed } })
  await resolveConfig(inline(await app(), plugin), command)
  expect(process.env.VITEHUB_MODELS).toBeUndefined()
  expect(process.env.VITEHUB_EMULATE_URL).toBeUndefined()
}, 30_000)

it("does not start the emulator for an environment that a CLI creates from a discovery config", async () => {
  // `vitehub env inspect` creates an SSR environment from a discovery config to load modules.
  const config = await resolveConfig({ ...inline(await app(), hubAgent({ models: { emulate: hello } })), vitehubCliDiscovery: true } as InlineConfig, "serve")
  // SAFETY: Vite's WebSocket type has a private brand. As in the Env CLI, a headless hot channel stands in for it.
  const ws = { ...createServerHotChannel(), clients: new Set() } as unknown as WebSocketServer
  const environment = await config.environments.ssr!.dev.createEnvironment("ssr", config, { ws })
  await environment.init()
  await environment.close()
  expect(process.env.VITEHUB_MODELS).toBeUndefined()
}, 30_000)

it("does not start the emulator without the option", async () => {
  await devServer(undefined)
  expect(process.env.VITEHUB_MODELS).toBeUndefined()
}, 30_000)

it("names the missing optional packages", async () => {
  vi.resetModules()
  vi.doMock("@emulators/ai", () => {
    throw new Error("Cannot find package '@emulators/ai'")
  })
  const { hubAgent: freshHubAgent } = await import("../src/vite.ts")
  await expect(createServer(inline(await app(), freshHubAgent({ models: { emulate: true } })))).rejects.toMatchObject({ code: "AGENT_EMULATOR_PACKAGES_MISSING" })
  expect(process.env.VITEHUB_MODELS).toBeUndefined()
}, 30_000)

it("names a rule that the emulator rejects and leaves nothing running", async () => {
  // SAFETY: The rule is invalid on purpose; the emulator validates the seed at startup.
  await expect(devServer({ rules: [{ id: "broken" }] } as unknown as AgentModelsEmulateSeed)).rejects.toMatchObject({ code: "AGENT_EMULATOR_RULES_INVALID" })
  expect(process.env.VITEHUB_MODELS).toBeUndefined()
  // The failed server holds no share, so a valid app starts on its own.
  await devServer(hello)
  expect(await invoke("hello")).toBe("Hi from the rule.")
}, 30_000)

it("releases the emulator if a Vite environment fails to initialize", async () => {
  vi.resetModules()
  const close = vi.fn(async () => {})
  vi.doMock("../src/internal/ai-emulator.ts", () => ({
    startAiEmulator: async () => ({ url: "http://127.0.0.1:4014", close, reseed: () => {} }),
  }))
  const { hubAgent: freshHubAgent } = await import("../src/vite.ts")
  const config = inline(await app(), freshHubAgent({ models: { emulate: true } }))
  const failure = new Error("Dev environment initialization failed")
  config.environments = {
    failing: {
      dev: {
        createEnvironment(name, resolved) {
          const environment = new DevEnvironment(name, resolved, { hot: false })
          environment.init = async () => { throw failure }
          return environment
        },
      },
    },
  }
  await expect(createServer(config)).rejects.toBe(failure)
  expect(close).toHaveBeenCalledOnce()
  expect(process.env.VITEHUB_MODELS).toBeUndefined()
  expect(process.env.VITEHUB_EMULATE_URL).toBeUndefined()
}, 30_000)

it("accepts the upstream seed type of emulateModels()", () => {
  expectTypeOf<EmulatedModelSeed>().toExtend<AgentModelsEmulateSeed>()
})
