import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { telegram } from "../src/channels.ts"
import { channelSimulationEnv } from "../src/internal/channel-simulation.ts"
import { hubAgent } from "../src/vite.ts"

const roots: string[] = []
const closers: Array<() => Promise<void>> = []
const previous = process.env[channelSimulationEnv]

beforeEach(() => {
  delete process.env[channelSimulationEnv]
})

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
  if (previous === undefined) delete process.env[channelSimulationEnv]
  else process.env[channelSimulationEnv] = previous
})

async function pluginFixture(simulate: boolean) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-channel-simulation-vite-"))
  roots.push(root)
  const plugin = hubAgent({ channels: { simulate } })
  // SAFETY: These fixtures provide the config fields read by the plugin hooks.
  const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
  // SAFETY: closeBundle is an object hook and needs no build context for a serve config.
  const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }
  const close = () => closeBundle.handler.call({})
  closers.push(close)
  return {
    close,
    resolve: (extra: object = {}) => configResolved({
      root, command: "serve", plugins: [], build: { outDir: "dist" }, resolve: { alias: [] },
      server: {}, logger: { info: vi.fn() }, createResolver: () => async () => undefined,
      ...extra,
    }),
  }
}

it("preserves simulation explicitly enabled in the user's environment", async () => {
  process.env[channelSimulationEnv] = "simulate"
  const enabled = await pluginFixture(true)
  const disabled = await pluginFixture(false)
  await enabled.resolve()
  await disabled.resolve()
  expect(process.env[channelSimulationEnv]).toBe("simulate")
  await enabled.close()
  expect(process.env[channelSimulationEnv]).toBe("simulate")
})

it("keeps concurrent servers enabled until the last one releases its environment", async () => {
  process.env[channelSimulationEnv] = "original"
  const first = await pluginFixture(true)
  const second = await pluginFixture(true)
  await first.resolve()
  await second.resolve()
  expect(process.env[channelSimulationEnv]).toBe("simulate")
  await first.close()
  expect(process.env[channelSimulationEnv]).toBe("simulate")
  await second.close()
  expect(process.env[channelSimulationEnv]).toBe("original")
})

it("ends plugin-owned simulation when a dev server closes", async () => {
  const first = await pluginFixture(true)
  await first.resolve()
  await first.close()
  expect(process.env[channelSimulationEnv]).toBeUndefined()
  const restarted = await pluginFixture(false)
  await restarted.resolve()
  expect(process.env[channelSimulationEnv]).toBeUndefined()
})

it("enables simulation in middleware-mode development servers such as Nuxt", async () => {
  const plugin = await pluginFixture(true)
  await plugin.resolve({ server: { middlewareMode: true } })
  expect(process.env[channelSimulationEnv]).toBe("simulate")
  expect(telegram({ mode: "polling" }).listener).toBeUndefined()
  await plugin.close()
  expect(process.env[channelSimulationEnv]).toBeUndefined()
  expect(telegram({ mode: "polling" }).listener).toEqual({ kind: "telegram-polling" })
})

it.each([
  { server: { middlewareMode: true }, vitehubCliDiscovery: true },
  { vitehubCliDiscovery: true },
  { command: "build" },
])("does not enable simulation during CLI discovery or builds: %j", async (config) => {
  const plugin = await pluginFixture(true)
  await plugin.resolve(config)
  expect(process.env[channelSimulationEnv]).toBeUndefined()
})
