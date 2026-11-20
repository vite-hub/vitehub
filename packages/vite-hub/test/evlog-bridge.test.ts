import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { evlogBridge, logFailure, setEvlogBridge } from "@vite-hub/internal/runtime/request-log"
import { executeStaticSchedule } from "@vite-hub/schedule/runtime/static"
import { createLogger, createRequestLogger, initLogger } from "evlog"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createDriver } from "../../blob/src/drivers/fs.ts"
import { createBlobStorage } from "../../blob/src/storage.ts"
import { evlogBridgeVitePlugin, renderEvlogBridgeNitroPlugin } from "../src/evlog-bridge-vite.ts"

interface NitroAppStub {
  hooks: {
    callHook: (name: string, context: { event: Record<string, unknown> }) => unknown
    hook: (name: string, handler: () => void) => void
  }
}

const roots: string[] = []
const runtimeGlobal = globalThis as typeof globalThis & { __vitehubTestRuntimeConfig?: Record<string, unknown> }
// Inside the package, so that the plugin's `import("evlog")` loads the real evlog of this workspace.
const pluginDir = fileURLToPath(new URL("../.vitest-tmp/evlog-bridge/", import.meta.url))

afterEach(async () => {
  setEvlogBridge(undefined)
  delete runtimeGlobal.__vitehubTestRuntimeConfig
  initLogger({ enabled: true, silent: true, drain: () => {} })
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

/** Runs the generated plugin with the real evlog and a stub of Nitro's runtime config. Returns the Nitro hooks. */
async function runBridge(runtimeConfig: Record<string, unknown>) {
  runtimeGlobal.__vitehubTestRuntimeConfig = runtimeConfig
  const source = renderEvlogBridgeNitroPlugin()
    .replace(`import { useRuntimeConfig } from "nitro/runtime-config"`, "const useRuntimeConfig = () => globalThis.__vitehubTestRuntimeConfig")
  await mkdir(pluginDir, { recursive: true })
  const file = join(pluginDir, `plugin-${crypto.randomUUID()}.mjs`)
  await writeFile(file, source)
  roots.push(file)
  const drained: Array<Record<string, unknown>> = []
  const closeHooks: Array<() => void> = []
  const nitroApp: NitroAppStub = {
    hooks: {
      callHook: (name, context) => { if (name === "evlog:drain") drained.push(context.event) },
      hook: (name, handler) => { if (name === "close") closeHooks.push(handler) },
    },
  }
  const plugin = (await import(pathToFileURL(file).href) as { default: (app: NitroAppStub) => Promise<void> }).default
  await plugin(nitroApp)
  return { close: () => closeHooks.forEach(hook => hook()), drained }
}

describe("generated evlog bridge Nitro plugin", () => {
  it("gives ViteHub packages evlog's logger and the app's drain hooks, and removes them on close", async () => {
    initLogger({ enabled: true, silent: true, drain: () => {} })
    const { close } = await runBridge({ evlog: {} })

    expect(evlogBridge()?.createLogger).toBe(createLogger)
    close()
    expect(evlogBridge()).toBeUndefined()
  })

  it("does nothing, and removes an old bridge, when the app does not register evlog or turns it off", async () => {
    for (const runtimeConfig of [{}, { evlog: { enabled: false } }]) {
      setEvlogBridge({ createLogger: vi.fn() })
      await runBridge(runtimeConfig)
      expect(evlogBridge()).toBeUndefined()
    }
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

describe("ViteHub failures with the real evlog", () => {
  // A failure whose message names a user's file, as an `fs` error does.
  const failure = () => Object.assign(new Error("EACCES: permission denied, open '/srv/data/.vitehub/blob-hashes/users/42/passport.jpg.json'"), { code: "EACCES" })

  it("keeps the reason when a Schedule throws a string", async () => {
    initLogger({ enabled: true, silent: true, drain: () => {} })
    const { drained } = await runBridge({ evlog: {} })
    const cron = "0 8 * * *"
    const handler = () => Promise.reject("quota exceeded")

    await expect(executeStaticSchedule({ cron, definition: { cron, handler }, name: "digest" })).rejects.toBe("quota exceeded")
    expect(drained).toMatchObject([{ error: { message: "quota exceeded" }, schedule: { name: "digest", outcome: "failure" } }])
  })

  it("puts a fixed message and the code on the request's wide event, never the error's message", async () => {
    initLogger({ enabled: true, silent: true, drain: () => {} })
    await runBridge({ evlog: {} })
    const log = createRequestLogger({ method: "GET", path: "/photos/users/42/passport.jpg" })
    const request = Object.assign(new Request("https://photos.example/x"), { context: { log } })
    const fallback = vi.fn()

    logFailure({ field: "blob", fields: { op: "transform-cache-write", store: "photos", driver: "fs" }, message: "Blob transform cache write failed", error: failure(), request }, fallback)
    const event = log.emit() as Record<string, unknown>

    expect(event).toMatchObject({ level: "warn", blob: { op: "transform-cache-write", store: "photos", driver: "fs", code: "EACCES" } })
    expect(JSON.stringify(event.requestLogs)).toContain("Blob transform cache write failed")
    expect(JSON.stringify(event)).not.toContain("passport.jpg.json")
    expect(JSON.stringify(event)).not.toContain("permission denied")
    expect(fallback).not.toHaveBeenCalled()
  })

  it("keeps the last Blob transform failure's metadata together on the request", async () => {
    initLogger({ enabled: true, silent: true, drain: () => {} })
    await runBridge({ evlog: {} })
    const directory = await mkdtemp(join(tmpdir(), "vitehub-evlog-blob-"))
    roots.push(directory)
    const driver = createDriver({ driver: "fs", base: directory })
    const storage = createBlobStorage(driver, "photos")
    const pathname = "passport.txt"
    await storage.put(pathname, "photo", { contentType: "text/plain" })
    const get = driver.get.bind(driver)
    const put = driver.put.bind(driver)
    vi.spyOn(driver, "get").mockImplementation(async (path) => {
      if (path.startsWith("_vitehub/derived/")) throw Object.assign(new Error("read failed"), { code: "EIO" })
      return get(path)
    })
    vi.spyOn(driver, "put").mockImplementation(async (path, ...args) => {
      if (path.startsWith("_vitehub/derived/")) throw new Error("write failed")
      return put(path, ...args)
    })
    const log = createRequestLogger({ method: "GET", path: "/photos/passport.txt" })
    const request = Object.assign(new Request("https://photos.example/passport.txt"), { context: { log } })

    const response = await storage.serve(request, pathname, { transform: { key: "public-v1", run: blob => blob } })
    expect(await response.text()).toBe("photo")
    const event = log.emit()
    expect(event?.blob).toEqual({ op: "transform-cache-write", store: "photos", driver: "fs" })
    expect(JSON.stringify(event?.requestLogs)).toContain("Blob transform cache read failed")
    expect(JSON.stringify(event?.requestLogs)).toContain("Blob transform cache write failed")
  })

  it("sends an event of its own to the app's drain hooks, without the error's message or stack", async () => {
    initLogger({ enabled: true, silent: true, drain: () => {} })
    const { drained } = await runBridge({ evlog: {} })
    const fallback = vi.fn()

    logFailure({ field: "blob", fields: { op: "fs-hash-cache-write", driver: "fs" }, level: "error", message: "Blob filesystem hash cache write failed", error: failure() }, fallback)
    await vi.waitFor(() => expect(drained).toHaveLength(1))

    expect(drained[0]).toMatchObject({ level: "error", action: "blob", message: "Blob filesystem hash cache write failed", blob: { op: "fs-hash-cache-write", driver: "fs", code: "EACCES" } })
    expect(JSON.stringify(drained[0])).not.toContain("passport")
    expect(JSON.stringify(drained[0])).not.toContain("permission denied")
    expect(fallback).not.toHaveBeenCalled()
  })

  it("prints to the console when the app turns evlog off, also for a request", async () => {
    initLogger({ enabled: true, silent: true, drain: () => {} })
    await runBridge({ evlog: {} })
    // evlog's Nitro plugin calls `initLogger({ enabled: false })` when the app sets `evlog({ enabled: false })`.
    initLogger({ enabled: false })
    const log = createRequestLogger({ method: "GET", path: "/photos" })
    const request = Object.assign(new Request("https://photos.example/x"), { context: { log } })
    const fallback = vi.fn()

    logFailure({ field: "blob", fields: { op: "transform-cache-write" }, message: "Blob transform cache write failed", error: failure(), request }, fallback)
    logFailure({ field: "blob", fields: { op: "fs-hash-cache-write" }, message: "Blob filesystem hash cache write failed", error: failure() }, fallback)

    expect(fallback).toHaveBeenCalledTimes(2)
  })
})
