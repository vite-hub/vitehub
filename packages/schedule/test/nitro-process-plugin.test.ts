import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { transform } from "esbuild"
import { afterEach, describe, expect, it, vi } from "vitest"

import { hubSchedule } from "../src/vite.ts"
import { normalizeScheduleRuntimeError } from "../src/runtime/static.ts"

interface RuntimeController {
  close: () => Promise<void> | void
}

interface RuntimeInstallOptions {
  [key: string]: unknown
  onError: (error: unknown) => void
}

interface PluginHarness {
  createKVScheduleRunStore: () => object
  definePlugin: <T>(plugin: T) => T
  installProcessScheduleRuntime: (options: RuntimeInstallOptions) => Promise<RuntimeController>
  normalizeScheduleRuntimeError: typeof normalizeScheduleRuntimeError
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

async function loadProcessPlugin(installProcessScheduleRuntime: PluginHarness["installProcessScheduleRuntime"], catchUpMs?: number) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-process-plugin-"))
  roots.push(root)
  await mkdir(join(root, "server"), { recursive: true })

  const plugin = hubSchedule({
    projectRoot: root,
    providerOutput: false,
    runtime: { driver: "process", ...(catchUpMs === undefined ? {} : { catchUpMs }) },
  })
  await (plugin.config as (config: Record<string, unknown>, env: { command: "serve", mode: string }) => Promise<unknown>)(
    { root },
    { command: "serve", mode: "development" },
  )

  const generated = await readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")
  const imports = [
    "const { createKVScheduleRunStore, definePlugin, installProcessScheduleRuntime, normalizeScheduleRuntimeError } = globalThis.__vitehubSchedulePluginHarness",
    "const scheduleKVStorage = {}",
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
    createKVScheduleRunStore: () => ({}),
    definePlugin: plugin => plugin,
    installProcessScheduleRuntime,
    normalizeScheduleRuntimeError,
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
  it("passes the Static Schedule registry and a run store to the Process Runtime", async () => {
    const installProcessScheduleRuntime = vi.fn(async (_options: RuntimeInstallOptions) => ({ close: vi.fn() }))
    const plugin = await loadProcessPlugin(installProcessScheduleRuntime)
    const { app } = createNitroApp()

    plugin(app)
    expect(installProcessScheduleRuntime).toHaveBeenCalledWith(expect.objectContaining({
      registry: expect.any(Object),
      scheduleRunStore: expect.any(Object),
    }))
    expect(installProcessScheduleRuntime.mock.calls[0]![0]).not.toHaveProperty("staticRegistry")
  })

  it("passes an explicit catchUpMs setting to the Process Runtime", async () => {
    const installProcessScheduleRuntime = vi.fn(async (_options: RuntimeInstallOptions) => ({ close: vi.fn() }))
    const plugin = await loadProcessPlugin(installProcessScheduleRuntime, 0)
    const { app } = createNitroApp()

    plugin(app)
    expect(installProcessScheduleRuntime.mock.calls[0]![0]).toHaveProperty("catchUpMs", 0)
  })

  it("logs reported runtime failures while preserving Nitro error capture", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const plugin = await loadProcessPlugin(async ({ onError }) => {
      onError("scheduled handler failed")
      return { close: vi.fn() }
    })
    const { app } = createNitroApp()
    app.captureError.mockImplementation(() => {
      throw new Error("Nitro capture failed")
    })

    try {
      expect(() => plugin(app)).not.toThrow()

      const runtimeError = consoleError.mock.calls[0]?.[1]
      expect(runtimeError).toBeInstanceOf(Error)
      expect(runtimeError).toMatchObject({ message: "scheduled handler failed" })
      expect(consoleError).toHaveBeenCalledWith("[vitehub:schedule]", runtimeError)
      expect(app.captureError).toHaveBeenCalledWith(runtimeError, { tags: ["vitehub-schedule"] })
    }
    finally {
      consoleError.mockRestore()
    }
  })

  it("preserves Nitro error capture when stderr logging fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("stderr unavailable")
    })
    const runtimeFailure = new Error("scheduled handler failed")
    const plugin = await loadProcessPlugin(async ({ onError }) => {
      onError(runtimeFailure)
      return { close: vi.fn() }
    })
    const { app } = createNitroApp()

    try {
      expect(() => plugin(app)).not.toThrow()
      expect(app.captureError).toHaveBeenCalledWith(runtimeFailure, { tags: ["vitehub-schedule"] })
    }
    finally {
      consoleError.mockRestore()
    }
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

  it("reports installation failures when runtime error coercion fails", async () => {
    const thrownValue = {
      toString() {
        throw new Error("runtime error coercion failed")
      },
    }
    const plugin = await loadProcessPlugin(() => Promise.reject(thrownValue))
    const { app, hooks } = createNitroApp()

    expect(() => plugin(app)).not.toThrow()
    await expect(hooks.get("request")!()).rejects.toBe(thrownValue)
    expect(app.captureError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SCHEDULE_R0035", cause: thrownValue }),
      { tags: ["vitehub-schedule"] },
    )
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
