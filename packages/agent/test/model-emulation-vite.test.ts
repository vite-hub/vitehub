import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from "vitest"

import { hubAgent } from "../src/vite.ts"

import type { EmulatedModelSeed } from "../src/test/emulate-models.ts"
import type { AgentModelsEmulateSeed, AgentModelsOptions } from "../src/types.ts"

const names = ["VITEHUB_MODELS", "VITEHUB_EMULATE_URL"] as const
const previous = names.map(name => [name, process.env[name]] as const)
const roots: string[] = []
const closers: Array<() => Promise<void>> = []

beforeEach(() => {
  for (const name of names) delete process.env[name]
})

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  vi.doUnmock("@emulators/ai")
  vi.resetModules()
})

type Nitro = { options: { dev: boolean, devServer: { runner?: string }, static?: boolean, cloudflare?: { wrangler?: { vars?: Record<string, unknown> } } } }

async function devServer(emulate: AgentModelsOptions["emulate"], plugin = hubAgent({ models: { emulate } })) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-model-emulation-vite-"))
  roots.push(root)
  const info = vi.fn<(message: string) => void>()
  // SAFETY: These fixtures provide the config fields that the plugin hooks read.
  const config = plugin.config as (config: unknown, env: unknown) => unknown
  const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
  // SAFETY: closeBundle is an object hook and needs no build context for a serve config.
  const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }
  const close = () => closeBundle.handler.call({})
  closers.push(close)
  return {
    close,
    info,
    nitro: (nitro: Nitro) => plugin.nitro!.setup(nitro),
    start: async (extra: object = {}, env: object = {}) => {
      const command = "command" in extra ? extra.command : "serve"
      await config({ root }, { command, mode: "development", ...env })
      await configResolved({
        root, command: "serve", plugins: [], build: { outDir: "dist" }, resolve: { alias: [] },
        server: {}, logger: { info }, createResolver: () => async () => undefined,
        ...extra,
      })
    },
  }
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

const hello: AgentModelsEmulateSeed = { rules: [{ id: "hello", match: { textContains: "hello" }, reply: [{ type: "text", text: "Hi from the rule." }] }] }

it("starts the AI emulator in vite dev, sets the switch, and stops it when the server closes", async () => {
  const server = await devServer(hello)
  await server.start()
  const url = process.env.VITEHUB_EMULATE_URL!
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  expect(process.env.VITEHUB_MODELS).toBe("emulate")
  expect(server.info).toHaveBeenCalledOnce()
  expect(server.info.mock.calls[0]![0]).toContain(url)
  expect(await ask(url, "hello there")).toBe("Hi from the rule.")

  await server.close()
  expect(process.env.VITEHUB_MODELS).toBeUndefined()
  expect(process.env.VITEHUB_EMULATE_URL).toBeUndefined()
  await expect(fetch(`${url}/_ai/rules`)).rejects.toThrow()
})

it("restores the values that the shell set", async () => {
  process.env.VITEHUB_EMULATE_URL = "http://127.0.0.1:4014"
  const server = await devServer(true)
  await server.start()
  expect(process.env.VITEHUB_EMULATE_URL).not.toBe("http://127.0.0.1:4014")
  await server.close()
  expect(process.env.VITEHUB_EMULATE_URL).toBe("http://127.0.0.1:4014")
  expect(process.env.VITEHUB_MODELS).toBeUndefined()
})

it("shares one emulator between dev servers until the last one closes", async () => {
  const first = await devServer(hello)
  const second = await devServer(hello)
  await first.start()
  const url = process.env.VITEHUB_EMULATE_URL!
  await second.start()
  expect(process.env.VITEHUB_EMULATE_URL).toBe(url)
  expect(second.info).not.toHaveBeenCalled()
  await first.close()
  expect(await ask(url, "hello")).toBe("Hi from the rule.")
  await second.close()
  expect(process.env.VITEHUB_MODELS).toBeUndefined()
  await expect(fetch(`${url}/_ai/rules`)).rejects.toThrow()
})

it("keeps the URL across a restart and applies edited rules", async () => {
  // Vite creates the new server before it closes the old one.
  const before = await devServer(hello)
  await before.start()
  const url = process.env.VITEHUB_EMULATE_URL!
  const after = await devServer({ rules: [{ id: "edited", match: { textContains: "hello" }, reply: [{ type: "text", text: "Edited rule." }] }] })
  await after.start()
  await before.close()
  expect(process.env.VITEHUB_EMULATE_URL).toBe(url)
  expect(await ask(url, "hello")).toBe("Edited rule.")
  expect(after.info.mock.calls.at(-1)![0]).toContain("replaced")
})

it("starts a new emulator on a new port after a full stop", async () => {
  const first = await devServer(true)
  await first.start()
  const url = process.env.VITEHUB_EMULATE_URL!
  await first.close()
  const second = await devServer(true)
  await second.start()
  expect(process.env.VITEHUB_EMULATE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  expect(process.env.VITEHUB_EMULATE_URL).not.toBe(url)
})

it("gives the miniflare dev runner the switch as Wrangler vars", async () => {
  const server = await devServer(true)
  const nitro: Nitro = { options: { dev: true, devServer: { runner: "miniflare" }, cloudflare: { wrangler: { vars: { OTHER: "1" } } } } }
  server.nitro(nitro)
  await server.start()
  expect(nitro.options.cloudflare?.wrangler?.vars).toEqual({ OTHER: "1", VITEHUB_MODELS: "emulate", VITEHUB_EMULATE_URL: process.env.VITEHUB_EMULATE_URL })

  const node = await devServer(true)
  const nodeNitro: Nitro = { options: { dev: true, devServer: { runner: "node-worker" } } }
  node.nitro(nodeNitro)
  await node.start()
  expect(nodeNitro.options.cloudflare).toBeUndefined()
})

it.each([
  { name: "a build", extra: { command: "build" } },
  { name: "vite preview", extra: {}, env: { isPreview: true } },
  { name: "CLI discovery", extra: { vitehubCliDiscovery: true } },
])("does not start the emulator in $name", async ({ extra, env }) => {
  const server = await devServer(hello)
  await server.start(extra, env)
  expect(process.env.VITEHUB_MODELS).toBeUndefined()
  expect(process.env.VITEHUB_EMULATE_URL).toBeUndefined()
  expect(server.info).not.toHaveBeenCalled()
})

it("does not start the emulator without the option", async () => {
  const server = await devServer(undefined, hubAgent())
  await server.start()
  expect(process.env.VITEHUB_MODELS).toBeUndefined()
})

it("names the missing optional packages", async () => {
  vi.resetModules()
  vi.doMock("@emulators/ai", () => {
    throw new Error("Cannot find package '@emulators/ai'")
  })
  const { hubAgent: freshHubAgent } = await import("../src/vite.ts")
  const server = await devServer(true, freshHubAgent({ models: { emulate: true } }))
  await expect(server.start()).rejects.toMatchObject({ code: "AGENT_EMULATOR_PACKAGES_MISSING" })
  expect(process.env.VITEHUB_MODELS).toBeUndefined()
})

it("names a rule that the emulator rejects", async () => {
  // SAFETY: The rule is invalid on purpose; the emulator validates the seed at startup.
  const server = await devServer({ rules: [{ id: "broken" }] } as unknown as AgentModelsOptions["emulate"])
  await expect(server.start()).rejects.toMatchObject({ code: "AGENT_EMULATOR_RULES_INVALID" })
  expect(process.env.VITEHUB_MODELS).toBeUndefined()
})

it("accepts the upstream seed type of emulateModels()", () => {
  expectTypeOf<EmulatedModelSeed>().toExtend<AgentModelsEmulateSeed>()
})
