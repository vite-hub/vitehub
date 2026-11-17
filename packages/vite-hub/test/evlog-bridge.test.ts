import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { evlogBridge, setEvlogBridge } from "@vite-hub/internal/runtime/request-log"
import { afterEach, describe, expect, it, vi } from "vitest"

import { evlogBridgeVitePlugin, renderEvlogBridgeNitroPlugin } from "../src/evlog-bridge-vite.ts"

type NitroPlugin = (app: { hooks: { callHook: (name: string, context: unknown) => unknown } }) => void

/** Evaluates the generated plugin with stubs for evlog and Nitro's runtime config. */
function bridgePlugin(runtimeConfig: Record<string, unknown>, createLogger: () => unknown): NitroPlugin {
  const source = renderEvlogBridgeNitroPlugin()
    .replace(/^import .*$/gm, "")
    .replace("export default function", "return function")
  // eslint-disable-next-line no-new-func -- evaluates the generated module body without a loader.
  return new Function("createLogger", "useRuntimeConfig", source)(createLogger, () => runtimeConfig) as NitroPlugin
}

const roots: string[] = []

afterEach(async () => {
  setEvlogBridge(undefined)
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("generated evlog bridge Nitro plugin", () => {
  it("gives ViteHub packages evlog's logger and the app's drain hooks when the app registers evlog", async () => {
    const createLogger = vi.fn()
    const callHook = vi.fn(async () => {})
    bridgePlugin({ evlog: {} }, createLogger)({ hooks: { callHook } })

    const bridge = evlogBridge()
    expect(bridge?.createLogger).toBe(createLogger)
    await bridge?.drain?.({ action: "schedule" })
    expect(callHook).toHaveBeenCalledWith("evlog:drain", { event: { action: "schedule" } })
  })

  it("does nothing when the app does not register evlog's Nitro module", () => {
    bridgePlugin({}, vi.fn())({ hooks: { callHook: vi.fn() } })
    expect(evlogBridge()).toBeUndefined()
  })

  it("registers the plugin only when the app installs evlog", async () => {
    const configure = async (root: string) => {
      const config: { root: string, nitro?: { plugins?: string[] } } = { root }
      const hook = evlogBridgeVitePlugin().config as (config: object, env: object) => Promise<void>
      await hook(config, { command: "build", mode: "production" })
      return config.nitro?.plugins ?? []
    }
    const root = await mkdtemp(join(tmpdir(), "vitehub-evlog-bridge-"))
    roots.push(root)
    await writeFile(join(root, "package.json"), "{}")
    expect(await configure(root)).toEqual([])

    await mkdir(join(root, "node_modules", "evlog"), { recursive: true })
    await writeFile(join(root, "node_modules", "evlog", "package.json"), "{}")
    expect(await configure(root)).toEqual([join(root, ".vitehub", "nitro", "evlog-bridge.mjs")])
  })
})
