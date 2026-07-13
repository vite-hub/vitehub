import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { transform } from "esbuild"
import { afterEach, describe, expect, it, vi } from "vitest"

import { hubSchedule } from "../src/vite.ts"

interface RuntimeController {
  close: () => Promise<void> | void
}

interface PluginHarness {
  createKVRuntimeScheduleStore: () => object
  createKVScheduleRunStore: () => object
  createProcessScheduleWakeDriver: () => () => void
  definePlugin: <T>(plugin: T) => T
  installScheduleRuntime: (options: Record<string, unknown>) => Promise<RuntimeController>
}

interface NitroAppHarness {
  captureError: ReturnType<typeof vi.fn>
  localFetch: ReturnType<typeof vi.fn>
  hooks: {
    hook: (name: string, handler: () => Promise<void>) => void
  }
}

const roots: string[] = []
const harnessGlobal = globalThis as typeof globalThis & {
  __vitehubSchedulePluginHarness?: PluginHarness
}

afterEach(async () => {
  delete harnessGlobal.__vitehubSchedulePluginHarness
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function loadProcessPlugin(installScheduleRuntime: PluginHarness["installScheduleRuntime"]) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-process-plugin-"))
  roots.push(root)
  await mkdir(join(root, "server"), { recursive: true })

  const plugin = hubSchedule({
    projectRoot: root,
    providerOutput: false,
    runtime: { driver: "process" },
  })
  await (plugin.config as (config: Record<string, unknown>, env: { command: "serve", mode: string }) => Promise<unknown>)(
    { root },
    { command: "serve", mode: "development" },
  )

  const generated = await readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")
  const imports = [
    "const { createKVRuntimeScheduleStore, createKVScheduleRunStore, createProcessScheduleWakeDriver, definePlugin, installScheduleRuntime } = globalThis.__vitehubSchedulePluginHarness",
    "const runtimeScheduleRegistry = {}",
    "const staticScheduleRegistry = {}",
  ].join("\n")
  const executable = await transform(`${imports}\n${generated.replace(/^import .*$/gm, "")}`, {
    format: "esm",
    loader: "ts",
    target: "es2022",
  })
  const pluginFile = join(root, "plugin.mjs")
  await writeFile(pluginFile, executable.code)

  harnessGlobal.__vitehubSchedulePluginHarness = {
    createKVRuntimeScheduleStore: () => ({}),
    createKVScheduleRunStore: () => ({}),
    createProcessScheduleWakeDriver: () => () => {},
    definePlugin: plugin => plugin,
    installScheduleRuntime,
  }

  const module = await import(`${pathToFileURL(pluginFile).href}?${Date.now()}-${Math.random()}`) as {
    default: (app: NitroAppHarness) => void
  }
  return module.default
}

function createNitroApp(localFetch = vi.fn()) {
  const hooks = new Map<string, () => Promise<void>>()
  const app: NitroAppHarness = {
    captureError: vi.fn(),
    localFetch,
    hooks: {
      hook(name, handler) {
        hooks.set(name, handler)
      },
    },
  }
  return { app, hooks }
}

describe("generated Nitro Process Runtime plugin", () => {
  it("passes separate Static and Runtime Schedule registries to execution", async () => {
    const installScheduleRuntime = vi.fn(async (_options: Record<string, unknown>) => ({ close: vi.fn() }))
    const plugin = await loadProcessPlugin(installScheduleRuntime)
    const { app } = createNitroApp()

    plugin(app)
    expect(installScheduleRuntime).toHaveBeenCalledWith(expect.objectContaining({
      registry: expect.any(Object),
      staticRegistry: expect.any(Object),
    }))
    const options = installScheduleRuntime.mock.calls[0]![0]
    expect(options.staticRegistry).not.toBe(options.registry)
  })

  it("installs without a fetch method on the Nitro app", async () => {
    const plugin = await loadProcessPlugin(async () => ({ close: vi.fn() }))
    const { app } = createNitroApp()

    expect(() => plugin(app)).not.toThrow()
  })

  it("waits for runtime installation in the Nitro request hook", async () => {
    let resolveInstallation!: (controller: RuntimeController) => void
    const installation = new Promise<RuntimeController>((resolve) => {
      resolveInstallation = resolve
    })
    const plugin = await loadProcessPlugin(() => installation)
    const { app, hooks } = createNitroApp()
    const close = vi.fn()

    plugin(app)
    let requestReady = false
    const requestPromise = hooks.get("request")!().then(() => { requestReady = true })
    await Promise.resolve()
    expect(requestReady).toBe(false)

    resolveInstallation({ close })
    await requestPromise
    expect(requestReady).toBe(true)

    await hooks.get("close")?.()
    expect(close).toHaveBeenCalledOnce()
  })

  it("surfaces installation failures from the Nitro request hook", async () => {
    const installationError = new Error("runtime installation failed")
    const plugin = await loadProcessPlugin(() => Promise.reject(installationError))
    const { app, hooks } = createNitroApp()

    plugin(app)
    await expect(hooks.get("request")!()).rejects.toBe(installationError)
    expect(app.captureError).toHaveBeenCalledWith(installationError, { tags: ["vitehub-schedule"] })
  })

  it("does not replace Nitro's local fetch entrypoint", async () => {
    const plugin = await loadProcessPlugin(async () => ({ close: vi.fn() }))
    const localFetch = vi.fn()
    const { app, hooks } = createNitroApp(localFetch)

    plugin(app)
    await hooks.get("request")!()

    expect(app.localFetch).toBe(localFetch)
  })
})
