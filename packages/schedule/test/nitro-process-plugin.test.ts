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
  installScheduleRuntime: () => Promise<RuntimeController>
}

interface NitroAppHarness {
  captureError: ReturnType<typeof vi.fn>
  fetch: (request: Request) => Promise<Response>
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

function createNitroApp(fetch: NitroAppHarness["fetch"]) {
  const hooks = new Map<string, () => Promise<void>>()
  const app: NitroAppHarness = {
    captureError: vi.fn(),
    fetch,
    hooks: {
      hook(name, handler) {
        hooks.set(name, handler)
      },
    },
  }
  return { app, hooks }
}

describe("generated Nitro Process Runtime plugin", () => {
  it("waits for runtime installation before delegating to the existing fetch handler", async () => {
    let resolveInstallation!: (controller: RuntimeController) => void
    const installation = new Promise<RuntimeController>((resolve) => {
      resolveInstallation = resolve
    })
    const plugin = await loadProcessPlugin(() => installation)
    const downstream = vi.fn(async () => new Response("route response"))
    const { app, hooks } = createNitroApp(downstream)
    const close = vi.fn()

    plugin(app)
    const responsePromise = app.fetch(new Request("http://localhost/report"))
    expect(downstream).not.toHaveBeenCalled()

    resolveInstallation({ close })
    await expect(responsePromise.then(response => response.text())).resolves.toBe("route response")
    expect(downstream).toHaveBeenCalledOnce()

    await hooks.get("close")?.()
    expect(close).toHaveBeenCalledOnce()
  })

  it("surfaces installation failures without calling the existing fetch handler", async () => {
    const installationError = new Error("runtime installation failed")
    const plugin = await loadProcessPlugin(() => Promise.reject(installationError))
    const downstream = vi.fn(async () => new Response("route response"))
    const { app } = createNitroApp(downstream)

    plugin(app)
    await expect(app.fetch(new Request("http://localhost/report"))).rejects.toBe(installationError)
    expect(downstream).not.toHaveBeenCalled()
    expect(app.captureError).toHaveBeenCalledWith(installationError, { tags: ["vitehub-schedule"] })
  })
})
