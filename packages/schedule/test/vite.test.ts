import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { afterAll, describe, expect, it, vi } from "vitest"

import { contributeProviderDeploymentOutput, createDefaultCloudflareOutputRoot, createDefaultNetlifyOutputRoot, createDefaultVercelOutputRoot, finalizeProviderDeploymentOutputs, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { createScheduleNitroConfig, hubSchedule } from "../src/vite.ts"

const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function runProviderOutputHooks(plugin: ReturnType<typeof hubSchedule>) {
  if (typeof plugin.buildEnd !== "function") throw new TypeError("Expected hubSchedule buildEnd hook")
  await plugin.buildEnd.call({} as never)
  if (!plugin.closeBundle || typeof plugin.closeBundle === "function") throw new TypeError("Expected hubSchedule closeBundle object hook")
  await (plugin.closeBundle as { handler: (this: never) => Promise<void> }).handler.call({} as never)
}

function hookHandler<T>(hook: unknown): T {
  const handler: unknown = typeof hook === "function" ? hook : Reflect.get(Object(hook), "handler")
  if (typeof handler !== "function") throw new TypeError("Expected a Vite hook.")
  // SAFETY: Each test passes the argument subset that the hook reads.
  return handler as T
}

function resolveScheduleRegistry(plugin: ReturnType<typeof hubSchedule>) {
  return hookHandler<(id: string) => unknown>(plugin.resolveId)("#vitehub/schedule/registry")
}

async function loadScheduleRegistry(plugin: ReturnType<typeof hubSchedule>) {
  return await hookHandler<(id: string) => string | Promise<string>>(plugin.load)("\0#vitehub/schedule/registry")
}

async function resolvePluginConfig(plugin: ReturnType<typeof hubSchedule>, root: string) {
  await (plugin.configResolved as (config: { root: string }) => Promise<void>)({ root })
}

// Generated code imports the Schedule runtime by file path, as `ownModule()` resolves it.
function ownRuntime(path: string) {
  return fileURLToPath(new URL(`../dist/${path}.js`, import.meta.url))
}

describe("Vite schedule integration", () => {
  it("serializes shared Provider Output finalization", () => {
    expect(hubSchedule().closeBundle).toMatchObject({ order: "post", sequential: true })
  })

  it("collects provider import aliases without a Workflow plugin", async () => {
    const root = await temporaryDirectory("vitehub-schedule-provider-aliases-")
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "cleanup.schedule.ts"), "export default defineSchedule({ cron: '0 0 * * *', handler: () => {} })\n", "utf8")
    const getImportAliases = vi.fn(async () => ({}))
    const plugin = hubSchedule({ providerOutput: "standalone" })

    await (plugin.config as (config: Record<string, unknown>, env: { command: "build", mode: string }) => unknown)({ root }, { command: "build", mode: "production" })
    await (plugin.configResolved as (config: Record<string, unknown>) => Promise<void>)({
      build: { outDir: "dist" },
      command: "build",
      plugins: [{ vitehub: { providerOutput: { getImportAliases } } }],
      resolve: { alias: [] },
      root,
    })
    await (plugin.buildEnd as (this: never) => Promise<void>).call({} as never)
    expect(getImportAliases).toHaveBeenCalledOnce()
    await (plugin.closeBundle as { handler: (this: never) => Promise<void> }).handler.call({} as never)

    expect(getImportAliases).toHaveBeenCalledOnce()
  })

  it("does not collect provider import aliases when no Schedule needs provider functions", async () => {
    const root = await temporaryDirectory("vitehub-schedule-provider-aliases-")
    const getImportAliases = vi.fn(async () => ({}))
    const plugin = hubSchedule()

    await (plugin.configResolved as (config: Record<string, unknown>) => Promise<void>)({
      build: { outDir: "dist" },
      command: "build",
      plugins: [{ vitehub: { providerOutput: { getImportAliases } } }],
      resolve: { alias: [] },
      root,
    })
    await (plugin.buildEnd as (this: never) => Promise<void>).call({} as never)
    await (plugin.closeBundle as { handler: (this: never) => Promise<void> }).handler.call({} as never)

    expect(getImportAliases).not.toHaveBeenCalled()
  })

  it("runs before downstream framework integrations that consume Provider Output config", () => {
    const plugin = hubSchedule()

    expect(plugin.enforce).toBe("pre")
  })

  it("invalidates registries for updates under a forwarded server directory", async () => {
    const root = await temporaryDirectory("vitehub-schedule-hmr-")
    const serverDir = join(root, "backend")
    const plugin = hubSchedule()
    await (plugin.config as (config: Record<PropertyKey, unknown>, env: { command: "serve", mode: string }) => unknown)({
      [VITEHUB_SERVER_DIRS]: [serverDir],
      root,
    }, { command: "serve", mode: "development" })
    await resolvePluginConfig(plugin, root)
    const registry = {}
    const invalidateModule = vi.fn()

    await (plugin.handleHotUpdate as (context: Record<string, unknown>) => Promise<unknown>)({
      file: join(serverDir, "schedules", "daily.ts"),
      server: {
        config: { root },
        moduleGraph: {
          getModuleById: () => registry,
          invalidateModule,
        },
      },
    })

    expect(invalidateModule).toHaveBeenCalledWith(registry)
  })

  it("invalidates the registry in the Nitro environment graph", async () => {
    const root = await temporaryDirectory("vitehub-schedule-hmr-env-")
    const plugin = hubSchedule()
    await (plugin.config as (config: Record<PropertyKey, unknown>, env: { command: "serve", mode: string }) => unknown)({ root }, { command: "serve", mode: "development" })
    await resolvePluginConfig(plugin, root)
    const nitroRegistry = {}
    const invalidateNitroModule = vi.fn()
    const send = vi.fn()

    await (plugin.handleHotUpdate as (context: Record<string, unknown>) => Promise<unknown>)({
      file: join(root, "server", "schedules", "daily.ts"),
      server: {
        config: { root },
        environments: {
          client: { config: { consumer: "client" }, hot: { send: vi.fn() }, moduleGraph: { getModuleById: () => undefined, invalidateModule: vi.fn() } },
          nitro: {
            config: { consumer: "server" },
            hot: { send },
            moduleGraph: { getModuleById: (id: string) => id === "\0#vitehub/schedule/registry" ? nitroRegistry : undefined, invalidateModule: invalidateNitroModule },
          },
        },
        moduleGraph: { getModuleById: () => undefined, invalidateModule: vi.fn() },
      },
    })

    expect(invalidateNitroModule).toHaveBeenCalledWith(nitroRegistry)
    expect(send).toHaveBeenCalledWith({ type: "full-reload" })
  })

  it("contributes discovered schedules to the in-flight Nitro config before framework plugins consume it", async () => {
    const root = await temporaryDirectory("vitehub-schedule-nitro-config-")
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "mirror.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '*/10 * * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")

    const userConfig: Record<string, unknown> = {
      [VITEHUB_NITRO_CONFIG_CONTEXT]: true,
      root,
      nitro: {
        cloudflare: {
          wrangler: {
            triggers: { crons: ["0 0 * * *"] },
          },
        },
      },
    }
    const plugin = hubSchedule()
    const config = await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      userConfig,
      { command: "build", mode: "production" },
    )

    expect(config).toBeUndefined()
    expect(userConfig).toMatchObject({
      nitro: {
        cloudflare: {
          wrangler: {
            triggers: { crons: ["0 0 * * *", "*/10 * * * *"] },
          },
        },
        modules: [join(root, ".vitehub/nitro/schedule/module.mjs")],
        plugins: [join(root, ".vitehub/nitro/schedule/plugin.ts")],
      },
    })
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")).resolves.toContain("cloudflare:scheduled")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")).resolves.toContain("./provider-registry.js")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")).resolves.toMatch(/[\\/]schedule[\\/](?:src|dist)[\\/]runtime[\\/]static\.(?:ts|js)"/)
    const moduleSource = await readFile(join(root, ".vitehub", "nitro", "schedule", "module.mjs"), "utf8")
    expect(moduleSource).toContain("build:before")
    expect(moduleSource).toContain("dedupeCloudflareCrons")
    expect(moduleSource).toContain("\"*/10 * * * *\"")
    expect(moduleSource).not.toContain("import type")
    expect(moduleSource).not.toContain(": Nitro")
    expect(moduleSource).not.toContain(": void")
    expect(moduleSource).not.toContain("cron is string")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "provider-registry.js"), "utf8")).resolves.toContain("[\"mirror\"]: async () => import(")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "provider-registry.d.ts"), "utf8")).resolves.toContain("ScheduleRegistryDefinition")
  })

  it("keeps the started Schedule tick alongside a time-zoned Static Definition", async () => {
    const root = await temporaryDirectory("vitehub-schedule-started-nitro-")
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "reminder.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ handler: ({ payload }) => console.log(payload) })",
      "",
    ].join("\n"), "utf8")

    await writeFile(join(root, "server", "schedules", "daily.ts"), "export default defineSchedule({ cron: '0 8 * * *', timeZone: 'Europe/Madrid', handler: () => {} })\n", "utf8")

    const userConfig: Record<string, unknown> = { [VITEHUB_NITRO_CONFIG_CONTEXT]: true, root }
    await (hubSchedule().config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      userConfig,
      { command: "build", mode: "production" },
    )

    expect(userConfig).toMatchObject({ nitro: { cloudflare: { wrangler: { triggers: { crons: ["0 6,7 * * *", "* * * * *"] } } } } })
    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")
    expect(pluginSource).toContain(`import { createKVStartedScheduleStore, installStartedSchedules } from ${JSON.stringify(ownRuntime("runtime"))}`)
    expect(pluginSource).toContain(`import { scheduleKVStorage } from ${JSON.stringify(ownRuntime("runtime/kv"))}`)
    expect(pluginSource).toContain("    catchUpMs: 0,")
    expect(pluginSource).toContain("cloudflare:scheduled")
    expect(pluginSource).toContain('timeZoneCrons: {"daily":"0 6,7 * * *"}')
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "started-registry.js"), "utf8")).resolves.toContain("[\"reminder\"]: async () => import(")
    const providerRegistry = await readFile(join(root, ".vitehub", "nitro", "schedule", "provider-registry.js"), "utf8")
    expect(providerRegistry).toContain("[\"vitehub/started-schedules\"]")
    expect(providerRegistry).not.toContain("[\"reminder\"]")
  })

  it("lets the Process Runtime wake Definitions without cron and catch up after a restart", async () => {
    const root = await temporaryDirectory("vitehub-schedule-started-process-")
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "reminder.ts"), "export default defineSchedule({ handler: () => {} })\n", "utf8")

    const userConfig: Record<string, unknown> = { root }
    await (hubSchedule({ runtime: { driver: "process", prefix: "app:schedule" } }).config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      userConfig,
      { command: "build", mode: "production" },
    )

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")
    expect(pluginSource).toContain("    catchUpMs: 3600000,")
    expect(pluginSource).toContain("store: createKVStartedScheduleStore({ ...{\"prefix\":\"app:schedule\"}, kvStore: scheduleKVStorage }),")
    expect(pluginSource.match(/import \{ scheduleKVStorage \}/g)).toHaveLength(1)
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "static-registry.js"), "utf8")).resolves.toContain("schedule-started/tick.mjs")
  })

  it("installs an explicit Process Runtime through generated Nitro wiring", async () => {
    const root = await temporaryDirectory("vitehub-schedule-process-runtime-")
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "report.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '*/10 * * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")

    const userConfig: Record<string, unknown> = { root }
    const plugin = hubSchedule({
      providerOutput: false,
      runtime: {
        concurrency: 2,
        driver: "process",
        intervalMs: 5_000,
        prefix: "brujula:schedule",
      },
    })
    const config = await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      userConfig,
      { command: "serve", mode: "development" },
    )

    expect(config).toBeUndefined()
    expect(userConfig).toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/schedule/plugin.ts"],
      },
    })
    expect(userConfig).not.toHaveProperty("nitro.cloudflare")
    expect(userConfig).not.toHaveProperty("nitro.modules")

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")
    expect(pluginSource).toContain(`import { installProcessScheduleRuntime, onShutdown } from ${JSON.stringify(ownRuntime("runtime/process"))}`)
    expect(pluginSource).toContain(`import { createKVScheduleRunStore } from ${JSON.stringify(ownRuntime("runtime"))}`)
    expect(pluginSource).not.toContain("RuntimeScheduleStore")
    expect(pluginSource).not.toContain("from \"@vite-hub/kv\"")
    expect(pluginSource).toContain(`import { scheduleKVStorage } from ${JSON.stringify(ownRuntime("runtime/kv"))}`)
    expect(pluginSource).toContain("kvStore: scheduleKVStorage")
    expect(pluginSource).toContain("\"prefix\": \"brujula:schedule\"")
    expect(pluginSource).toContain("\"concurrency\": 2")
    expect(pluginSource).toContain("\"intervalMs\": 5000")
    expect(pluginSource).toContain("nitroApp.captureError")
    expect(pluginSource).toContain("nitroApp.hooks.hook('request'")
    expect(pluginSource).not.toContain("nitroApp.fetch")
    expect(pluginSource).toContain("const result = await runtimeInstallation")
    expect(pluginSource).toContain("if ('error' in result) throw result.error")
    expect(pluginSource).toContain("if ('controller' in result) await result.controller.close()")
    // ViteHub shutdown owns stop signals. The plugin only registers its drain.
    expect(pluginSource).toContain("onShutdown(nitroApp, 'schedule', () => runtimeInstallation.then(async (result) => {")
    expect(pluginSource).not.toContain("SIGTERM")
    expect(pluginSource).not.toContain("setTimeout")
    expect(pluginSource).toContain("export default definePlugin((nitroApp) => {")
    expect(pluginSource).not.toContain("definePlugin(async")
    expect(pluginSource).not.toContain("runtime-registry.js")
    expect(pluginSource).toContain("staticScheduleRegistry from \"./static-registry.js\"")
    expect(pluginSource).toContain("registry: staticScheduleRegistry")
    expect(pluginSource).not.toContain("cloudflare:scheduled")
    const drainStart = pluginSource.indexOf("  onShutdown(nitroApp, 'schedule'")
    const drainEnd = pluginSource.indexOf("  nitroApp.hooks.hook('request'", drainStart)
    const drainJavaScript = pluginSource.slice(drainStart, drainEnd)
    const closed = vi.fn(async () => {})
    const drains = new Map<string, () => Promise<void>>()
    // SAFETY: The generated statement uses only the names that this test passes in.
    new Function("onShutdown", "nitroApp", "runtimeInstallation", "captureRuntimeError", drainJavaScript)(
      (_app: unknown, name: string, drain: () => Promise<void>) => drains.set(name, drain),
      {},
      Promise.resolve({ controller: { close: closed } }),
      vi.fn(),
    )
    await drains.get("schedule")!()
    expect(closed).toHaveBeenCalledOnce()
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "runtime-registry.js"), "utf8")).rejects.toThrow()
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "static-registry.js"), "utf8")).resolves.toContain("server/schedules/report.ts")
    await resolvePluginConfig(plugin, root)
    expect(resolveScheduleRegistry(plugin)).toBe("\0#vitehub/schedule/registry")
    await expect(loadScheduleRegistry(plugin)).resolves.toContain("server/schedules/report.ts")
  })

  it("filters the resolveId and load hooks to the Schedule registry", () => {
    const plugin = hubSchedule({ providerOutput: false })
    const idFilter = (hook: unknown) => Reflect.get(Object(Reflect.get(Object(hook), "filter")), "id") as RegExp
    const ids = ["#vitehub/schedule/registry", "\0#vitehub/schedule/registry", "#vitehub/schedule/registry.mjs", "\0#vitehub/schedule/targets", "@vite-hub/schedule", "/app/server/schedules/report.ts"]
    expect(ids.filter(id => idFilter(plugin.resolveId).test(id))).toEqual(["#vitehub/schedule/registry"])
    expect(ids.filter(id => idFilter(plugin.load).test(id))).toEqual(["\0#vitehub/schedule/registry"])
  })

  it("gives a built Process Runtime the static cron of each Schedule, so it loads Schedule modules when they are due", async () => {
    const root = await temporaryDirectory("vitehub-schedule-process-timings-")
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await Promise.all([
      writeFile(join(root, "server", "schedules", "report.ts"), "import { defineSchedule } from '@vite-hub/schedule'\nexport default defineSchedule({ cron: '0 9 * * *', timeZone: 'Europe/Madrid', handler: () => {} })\n", "utf8"),
      writeFile(join(root, "server", "schedules", "cleanup.ts"), "import { defineSchedule } from '@vite-hub/schedule'\nexport default defineSchedule({ cron: '*/5 * * * *', handler: () => {} })\n", "utf8"),
      // A cron that only the module knows: the runtime loads it at startup.
      writeFile(join(root, "server", "schedules", "dynamic.ts"), "import { defineSchedule } from '@vite-hub/schedule'\nconst cron = process.env.CRON ?? '* * * * *'\nexport default defineSchedule({ cron, handler: () => {} })\n", "utf8"),
    ])
    const generate = async (command: "build" | "serve") => {
      const plugin = hubSchedule({ projectRoot: root, providerOutput: false, runtime: { driver: "process" } })
      await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)({ root }, { command, mode: command === "build" ? "production" : "development" })
      return await readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")
    }

    const built = await generate("build")
    const options = JSON.parse(/const processRuntimeOptions = (\{[\s\S]*?\n\})/.exec(built)![1]!) as unknown
    expect(options).toEqual({
      timings: {
        cleanup: { cron: "*/5 * * * *" },
        report: { cron: "0 9 * * *", timeZone: "Europe/Madrid" },
      },
    })
    // `vite dev` loads every Schedule at startup, so an edited cron applies at once.
    expect(await generate("serve")).not.toContain("timings")
  })

  it("installs an explicit Process Runtime with an empty canonical registry", async () => {
    const root = await temporaryDirectory("vitehub-schedule-empty-process-runtime-")
    const userConfig: Record<string, unknown> = { root }
    const plugin = hubSchedule({
      projectRoot: root,
      providerOutput: false,
      runtime: { driver: "process" },
    })

    const config = await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      userConfig,
      { command: "serve", mode: "development" },
    )

    expect(config).toBeUndefined()
    expect(userConfig).toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/schedule/plugin.ts"],
      },
    })
    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")
    expect(pluginSource).toContain("staticScheduleRegistry from \"./static-registry.js\"")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "static-registry.js"), "utf8")).resolves.toContain("const registry = {")
    await resolvePluginConfig(plugin, root)
    expect(resolveScheduleRegistry(plugin)).toBe("\0#vitehub/schedule/registry")
    await expect(loadScheduleRegistry(plugin)).resolves.toContain("const registry = {")
  })

  it("lets the Process Runtime own Static Schedule execution when configured", async () => {
    const root = await temporaryDirectory("vitehub-schedule-process-static-")
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await mkdir(join(root, "src"), { recursive: true })
    await mkdir(join(root, "dist", "client"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "report.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '*/10 * * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")
    await writeFile(join(root, "src", "cleanup.schedule.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '0 0 * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")

    const userConfig: Record<string, unknown> = { root }
    const plugin = hubSchedule({ runtime: { driver: "process" } })
    await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      userConfig,
      { command: "build", mode: "production" },
    )

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")
    expect(pluginSource).not.toContain("cloudflare:scheduled")
    expect(pluginSource).toContain("installProcessScheduleRuntime")
    expect(pluginSource).toContain("staticScheduleRegistry from \"./static-registry.js\"")
    const generatedStaticRegistry = await readFile(join(root, ".vitehub", "nitro", "schedule", "static-registry.js"), "utf8")
    await resolvePluginConfig(plugin, root)
    const runtimeRegistry = await loadScheduleRegistry(plugin)
    await expect(readFile(join(root, ".vitehub", "schedule", "registry.js"), "utf8")).rejects.toThrow()
    expect(runtimeRegistry).toContain("server/schedules/report.ts")
    expect(runtimeRegistry).toContain("src/cleanup.schedule.ts")
    expect(generatedStaticRegistry).toContain("server/schedules/report.ts")
    expect(generatedStaticRegistry).toContain("src/cleanup.schedule.ts")
    await (plugin.configResolved as (config: Record<string, unknown>) => Promise<void>)({
      build: { outDir: "dist/client" },
      command: "build",
      resolve: { alias: [] },
      root,
    })
    await runProviderOutputHooks(plugin)
    expect(existsSync(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"))).toBe(false)
    await expect(readFile(join(createDefaultNetlifyOutputRoot(root), "functions", "vitehub-schedule-cleanup.mjs"), "utf8")).rejects.toThrow()
  })

  it("honors explicit Nitro Provider Wake output with the Process Runtime", async () => {
    const root = await temporaryDirectory("vitehub-schedule-process-nitro-output-")
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "cleanup.schedule.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '0 0 * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")

    const plugin = hubSchedule({ projectRoot: root, providerOutput: "nitro", runtime: { driver: "process" } })
    await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      { root },
      { command: "build", mode: "production" },
    )

    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")).resolves.toContain("cloudflare:scheduled")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "static-registry.js"), "utf8")).resolves.not.toContain("src/cleanup.schedule.ts")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.mjs"), "utf8")).resolves.toContain("\"0 0 * * *\"")
  })

  it("honors explicit standalone Provider Wake output with the Process Runtime", async () => {
    const root = await temporaryDirectory("vitehub-schedule-process-standalone-output-")
    await mkdir(join(root, "src"), { recursive: true })
    await mkdir(join(root, "dist", "client"), { recursive: true })
    await writeFile(join(root, "src", "cleanup.schedule.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '0 0 * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")

    const plugin = hubSchedule({ projectRoot: root, providerOutput: "standalone", runtime: { driver: "process" } })
    await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      { root },
      { command: "build", mode: "production" },
    )
    await (plugin.configResolved as (config: Record<string, unknown>) => Promise<void>)({
      build: { outDir: "dist/client" },
      command: "build",
      resolve: { alias: [] },
      root,
    })
    await runProviderOutputHooks(plugin)

    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")).resolves.not.toContain("cloudflare:scheduled")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "static-registry.js"), "utf8")).resolves.not.toContain("src/cleanup.schedule.ts")
    await expect(readFile(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"), "utf8")).resolves.toContain("\"0 0 * * *\"")
    await expect(readFile(join(createDefaultNetlifyOutputRoot(root), "functions", "vitehub-schedule-cleanup.mjs"), "utf8")).resolves.toContain("schedule: \"0 0 * * *\"")
  })

  it("snapshots schedules before deferred Provider Output finalization", async () => {
    const root = await temporaryDirectory("vitehub-schedule-provider-output-snapshot-")
    const scheduleFile = join(root, "src", "cleanup.schedule.ts")
    await mkdir(join(root, "src"), { recursive: true })
    await mkdir(join(root, "dist", "client"), { recursive: true })
    await writeFile(scheduleFile, "export default defineSchedule({ cron: '0 0 * * *', handler: () => {} })\n", "utf8")

    const prepareSources = async (sources: { resolve: (path: string) => string }) => {
      const retainedFile = sources.resolve(scheduleFile)
      await writeFile(retainedFile, `${await readFile(retainedFile, "utf8")}\n// Owner decoration.\n`)
    }
    const plugin = hubSchedule({ providerOutput: "standalone" })
    await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      { root },
      { command: "build", mode: "production" },
    )
    await (plugin.configResolved as (config: Record<string, unknown>) => Promise<void>)({
      build: { outDir: "dist/client" },
      command: "build",
      plugins: [{ vitehub: { providerOutput: { prepareSources } } }],
      resolve: { alias: [] },
      root,
    })
    await (plugin.buildEnd as (this: never) => Promise<void>).call({} as never)

    await expect(readFile(scheduleFile, "utf8")).resolves.not.toContain("Owner decoration.")
    await writeFile(scheduleFile, "export default defineSchedule({ cron: '5 0 * * *', handler: () => {} })\n", "utf8")
    await (plugin.closeBundle as { handler: (this: never) => Promise<void> }).handler.call({} as never)

    await expect(readFile(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"), "utf8")).resolves.toContain("\"0 0 * * *\"")
    await expect(readFile(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"), "utf8")).resolves.not.toContain("\"5 0 * * *\"")
    const registry = await readFile(join(root, ".vitehub", "schedule", "registry.mjs"), "utf8")
    expect(registry).toContain("./sources/")
    expect(registry).not.toContain("schedule-generations")
    const providerOutputs = await Promise.all([
      readFile(join(createDefaultCloudflareOutputRoot(root), "index.js"), "utf8"),
      readFile(join(root, ".vitehub", "schedule", "deno-cron.mjs"), "utf8"),
      readFile(join(createDefaultNetlifyOutputRoot(root), "functions", "vitehub-schedule-cleanup.mjs"), "utf8"),
      readFile(join(createDefaultVercelOutputRoot(root), "functions", "api", "vitehub", "schedules", "vercel", "cleanup.func", "index.mjs"), "utf8"),
    ])
    expect(providerOutputs.join("\n")).not.toContain("schedule-generations")
    for (const output of providerOutputs) {
      expect(output).toContain('cron: "0 0 * * *"')
      expect(output).not.toContain('cron: "5 0 * * *"')
    }
    const retainedScheduleSpecifier = registry.match(/import\("(\.\/sources\/[^"]+\/cleanup\.schedule\.ts)"\)/)?.[1]
    expect(retainedScheduleSpecifier).toBeDefined()
    const retainedSchedulePath = retainedScheduleSpecifier!.slice(2)
    for (const directory of [
      join(root, ".vitehub", "schedule"),
      join(createDefaultCloudflareOutputRoot(root), ".vitehub", "schedule"),
      join(createDefaultVercelOutputRoot(root), "functions", "api", "vitehub", "schedules", "vercel", "cleanup.func", ".vitehub", "schedule"),
    ]) {
      await expect(readFile(join(directory, retainedSchedulePath), "utf8")).resolves.toContain("Owner decoration.")
    }
    await expect(readFile(join(root, ".vitehub", "schedule", retainedSchedulePath), "utf8"))
      .resolves.toContain("cron: '0 0 * * *'")
    await expect(readFile(join(createDefaultCloudflareOutputRoot(root), ".vitehub", "schedule", retainedSchedulePath), "utf8"))
      .resolves.toContain("cron: '0 0 * * *'")
    await expect(readFile(join(createDefaultVercelOutputRoot(root), "functions", "api", "vitehub", "schedules", "vercel", "cleanup.func", ".vitehub", "schedule", retainedSchedulePath), "utf8"))
      .resolves.toContain("cron: '0 0 * * *'")
  })

  it("resets pending Provider Output when schedule preparation fails", async () => {
    const root = await temporaryDirectory("vitehub-schedule-provider-output-invalid-")
    const scheduleFile = join(root, "src", "cleanup.schedule.ts")
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(scheduleFile, "export default defineSchedule({ cron: getCron(), handler: () => {} })\n", "utf8")

    const plugin = hubSchedule({ providerOutput: "standalone" })
    await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      { root },
      { command: "build", mode: "production" },
    )
    const config = {
      build: { outDir: "dist/client" },
      command: "build",
      plugins: [],
      resolve: { alias: [] },
      root,
    }
    await (plugin.configResolved as (config: Record<string, unknown>) => Promise<void>)(config)
    const catalog = useProviderOutputCatalog(config)
    const write = vi.fn(async () => undefined)
    contributeProviderDeploymentOutput(catalog, { owner: "blob", rootDir: root, write })

    // SAFETY: This focused hook test supplies no Vite plugin context because the failing discovery path does not read it.
    await expect((plugin.buildEnd as (this: never) => Promise<void>).call({} as never)).rejects.toThrow()
    await finalizeProviderDeploymentOutputs(catalog)

    expect(write).not.toHaveBeenCalled()
  })

  it("preserves forwarded server directories in standalone Provider Output", async () => {
    const root = await temporaryDirectory("vitehub-schedule-forwarded-standalone-output-")
    const serverDir = join(root, "backend")
    await mkdir(join(serverDir, "schedules"), { recursive: true })
    await mkdir(join(root, "dist", "client"), { recursive: true })
    await writeFile(join(serverDir, "schedules", "daily.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '0 2 * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")

    const plugin = hubSchedule({ projectRoot: root, providerOutput: "standalone" })
    await (plugin.config as (config: Record<PropertyKey, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      { [VITEHUB_SERVER_DIRS]: [serverDir], root },
      { command: "build", mode: "production" },
    )
    await (plugin.configResolved as (config: Record<string, unknown>) => Promise<void>)({
      build: { outDir: "dist/client" },
      command: "build",
      resolve: { alias: [] },
      root,
    })
    await runProviderOutputHooks(plugin)

    const config = JSON.parse(await readFile(join(root, ".vercel", "output", "config.json"), "utf8"))
    expect(config.crons).toContainEqual({
      path: "/api/vitehub/schedules/vercel/daily",
      schedule: "0 2 * * *",
    })
  })

  it("emits server schedules in explicit standalone Provider Wake output", async () => {
    const root = await temporaryDirectory("vitehub-schedule-server-standalone-output-")
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await mkdir(join(root, "dist", "client"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "report.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '0 9 * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")

    const plugin = hubSchedule({ projectRoot: root, providerOutput: "standalone" })
    await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      { root },
      { command: "build", mode: "production" },
    )
    await (plugin.configResolved as (config: Record<string, unknown>) => Promise<void>)({
      build: { outDir: "dist/client" },
      command: "build",
      resolve: { alias: [] },
      root,
    })
    await runProviderOutputHooks(plugin)

    await expect(readFile(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"), "utf8")).resolves.toContain("\"0 9 * * *\"")
    await expect(readFile(join(createDefaultNetlifyOutputRoot(root), "functions", "vitehub-schedule-report.mjs"), "utf8")).resolves.toContain("schedule: \"0 9 * * *\"")
  })

  it("writes standalone Provider Output only for the host of Nitro's resolved preset", async () => {
    const root = await temporaryDirectory("vitehub-schedule-nitro-preset-output-")
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await mkdir(join(root, "dist", "client"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "report.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '0 9 * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")

    const plugin = hubSchedule({ projectRoot: root, providerOutput: "standalone" })
    const nitroModule = plugin.nitro as { setup: (nitro: { options: { preset: string } }) => void }
    nitroModule.setup({ options: { preset: "netlify" } })
    nitroModule.setup({ options: { preset: "nitro-prerender" } })
    await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      { root },
      { command: "build", mode: "production" },
    )
    await (plugin.configResolved as (config: Record<string, unknown>) => Promise<void>)({
      build: { outDir: "dist/client" },
      command: "build",
      resolve: { alias: [] },
      root,
    })
    await runProviderOutputHooks(plugin)

    await expect(readFile(join(createDefaultNetlifyOutputRoot(root), "functions", "vitehub-schedule-report.mjs"), "utf8")).resolves.toContain("schedule: \"0 9 * * *\"")
    expect(existsSync(createDefaultCloudflareOutputRoot(root))).toBe(false)
    expect(existsSync(createDefaultVercelOutputRoot(root))).toBe(false)
    expect(existsSync(join(root, ".vitehub", "schedule", "deno-cron.mjs"))).toBe(false)
  })

  it("writes a resolvable Process Runtime registry for direct Nitro config integration", async () => {
    const root = await temporaryDirectory("vitehub-schedule-direct-nitro-process-")
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "report.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '0 9 * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")

    await expect(createScheduleNitroConfig({
      command: "serve",
      providerOutput: false,
      root,
      runtime: { driver: "process" },
    })).resolves.toMatchObject({
      plugins: [".vitehub/nitro/schedule/plugin.ts"],
    })

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")
    expect(pluginSource).toContain("staticScheduleRegistry from \"./static-registry.js\"")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "runtime-registry.js"), "utf8")).rejects.toThrow()
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "static-registry.js"), "utf8")).resolves.toContain("server/schedules/report.ts")
  })

  it("does not infer a Process Runtime from Nitro or discovered definitions", async () => {
    const root = await temporaryDirectory("vitehub-schedule-no-process-runtime-")
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "report.ts"), "export default defineSchedule({ cron: '* * * * *', handler: () => {} })\n", "utf8")

    const plugin = hubSchedule()
    await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      { root },
      { command: "serve", mode: "development" },
    )

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")
    expect(pluginSource).not.toContain("installProcessScheduleRuntime")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "runtime-registry.js"), "utf8")).rejects.toThrow()
  })

  it("adds no dev endpoint or Nitro dev handler, and contributes the schedule operations", async () => {
    const root = await temporaryDirectory("vitehub-schedule-no-dev-handler-")
    const plugin = hubSchedule({ projectRoot: root })
    expect(plugin.configureServer).toBeUndefined()
    const serveConfig: Record<string, unknown> = { nitro: { baseURL: "/app/" }, root }
    await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      serveConfig,
      { command: "serve", mode: "development" },
    )

    expect(JSON.stringify(serveConfig.nitro)).not.toContain("dev-handler")
    expect(JSON.stringify(serveConfig.nitro)).not.toContain("/_vitehub/schedule/dev")
    const [contribution] = (plugin.vitehub as { operations: Array<{ export: string, load(): Promise<readonly { name: string }[]>, module: string }> }).operations
    expect(contribution).toMatchObject({ export: "scheduleOperations", module: expect.stringMatching(/[\\/]schedule[\\/](?:src|dist)[\\/]operations\.(?:ts|js)$/) })
    expect((await contribution!.load()).map(operation => operation.name)).toEqual(["schedule.runs", "schedule.attempts", "schedule.run", "schedule.list", "schedule.start", "schedule.cancel"])
  })

  it("rejects invalid Process Runtime options before generating Nitro code", async () => {
    const root = await temporaryDirectory("vitehub-schedule-invalid-process-")
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "report.ts"), "export default defineSchedule({ cron: '* * * * *', handler: () => {} })\n", "utf8")

    for (const runtime of [
      { driver: "process", intervalMs: 0 },
      { driver: "process", intervalMs: 60_001 },
      { concurrency: 0, driver: "process" },
      { driver: "process", prefix: 1 },
    ]) {
      const plugin = hubSchedule({ runtime: runtime as never })
      await expect((plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
        { root },
        { command: "serve", mode: "development" },
      )).rejects.toThrow("Process Runtime")
    }
  })

  it("discovers project server schedules when the Vite root is nested", async () => {
    const root = await temporaryDirectory("vitehub-schedule-nested-root-")
    const appRoot = join(root, "app")
    await mkdir(join(appRoot, "src"), { recursive: true })
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(appRoot, "src", "cleanup.schedule.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '0 0 * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")
    await writeFile(join(root, "server", "schedules", "sync.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '0 4 * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")

    const userConfig: Record<string, unknown> = { root: appRoot }
    const plugin = hubSchedule()
    const config = await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      userConfig,
      { command: "build", mode: "production" },
    )
    await resolvePluginConfig(plugin, appRoot)
    const registry = await loadScheduleRegistry(plugin)

    expect(config).toBeUndefined()
    expect(userConfig).toMatchObject({
      nitro: {
        cloudflare: {
          wrangler: {
            triggers: { crons: ["0 4 * * *"] },
          },
        },
        modules: ["./.vitehub/nitro/schedule/module.mjs"],
        plugins: [".vitehub/nitro/schedule/plugin.ts"],
      },
    })
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")).resolves.toContain("cloudflare:scheduled")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.mjs"), "utf8")).resolves.toContain("\"0 4 * * *\"")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.mjs"), "utf8")).resolves.not.toContain("\"0 0 * * *\"")
    await expect(readFile(join(appRoot, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")).rejects.toThrow()
    expect(registry).toContain("[\"cleanup\"]: async () => import(")
    expect(registry).toContain("[\"sync\"]: async () => import(")
    expect(registry).toContain(`import(${JSON.stringify(join(root, "app", "src", "cleanup.schedule.ts"))})`)
    expect(registry).toContain(`import(${JSON.stringify(join(root, "server", "schedules", "sync.ts"))})`)
  })

  it("does not install Nitro plugin output for suffix-only standalone schedules by default", async () => {
    const root = await temporaryDirectory("vitehub-schedule-standalone-")
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "cleanup.schedule.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '0 0 * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")

    const plugin = hubSchedule()
    const config = await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)({
      root,
    }, { command: "build", mode: "production" })

    expect(config).toBeNull()
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")).rejects.toThrow()
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.mjs"), "utf8")).rejects.toThrow()
  })

  it("adds standalone schedules to Vercel's Nitro output config", async () => {
    const root = await temporaryDirectory("vitehub-schedule-vercel-")
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "cleanup.schedule.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '0 0 * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")

    const userConfig: Record<string, unknown> = {
      nitro: {
        preset: "vercel",
        vercel: { config: { crons: [
          { path: "/api/user", schedule: "5 0 * * *" },
          { path: "/api/vitehub/schedules/vercel/authored", schedule: "10 0 * * *" },
          { path: "/api/vitehub/schedules/vercel/cleanup", schedule: "15 0 * * *" },
        ] } },
      },
      root,
    }
    const plugin = hubSchedule({ providerOutput: "standalone" })
    await (plugin.config as (config: Record<string, unknown>, env: { command: "build", mode: string }) => unknown)(
      userConfig,
      { command: "build", mode: "production" },
    )

    expect(userConfig).toMatchObject({
      nitro: {
        vercel: {
          config: {
            crons: [
              { path: "/api/user", schedule: "5 0 * * *" },
              { path: "/api/vitehub/schedules/vercel/authored", schedule: "10 0 * * *" },
              { path: "/api/vitehub/schedules/vercel/cleanup", schedule: "0 0 * * *" },
            ],
          },
        },
      },
    })
    expect(userConfig).not.toHaveProperty("nitro.plugins")
  })

  it("adds auto-selected standalone schedules to Vercel's Nitro output config", async () => {
    const root = await temporaryDirectory("vitehub-schedule-vercel-auto-")
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "cleanup.schedule.ts"), "export default defineSchedule({ cron: '0 0 * * *', handler: () => {} })\n", "utf8")

    const nitro = await createScheduleNitroConfig({
      command: "build",
      nitro: { preset: "vercel" },
      root,
    })

    expect(nitro).toMatchObject({
      vercel: { config: { crons: [{ path: "/api/vitehub/schedules/vercel/cleanup", schedule: "0 0 * * *" }] } },
    })
  })

  it("does not add auto-selected Vercel crons when Process Runtime owns the schedule", async () => {
    const root = await temporaryDirectory("vitehub-schedule-vercel-auto-process-")
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "cleanup.schedule.ts"), "export default defineSchedule({ cron: '0 0 * * *', handler: () => {} })\n", "utf8")

    const nitro = await createScheduleNitroConfig({
      command: "build",
      nitro: { preset: "vercel" },
      root,
      runtime: { driver: "process" },
    })

    expect(nitro).not.toHaveProperty("vercel.config.crons")
  })

  it.each(["NITRO_PRESET", "SERVER_PRESET"])("adds standalone schedules to Vercel Nitro config selected by %s", async (environmentVariable) => {
    const root = await temporaryDirectory("vitehub-schedule-vercel-env-")
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "cleanup.schedule.ts"), "export default defineSchedule({ cron: '0 0 * * *', handler: () => {} })\n", "utf8")
    vi.stubEnv(environmentVariable, "vercel")
    try {
      const nitro = await createScheduleNitroConfig({
        command: "build",
        providerOutput: "standalone",
        root,
      })
      expect(nitro).toMatchObject({
        vercel: { config: { crons: [{ path: "/api/vitehub/schedules/vercel/cleanup", schedule: "0 0 * * *" }] } },
      })
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it("can force Nitro plugin output for suffix schedules", async () => {
    const root = await temporaryDirectory("vitehub-schedule-force-nitro-")
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "cleanup.schedule.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '0 0 * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")

    const plugin = hubSchedule({ providerOutput: "nitro" })
    const userConfig: Record<string, unknown> = {
      root,
    }
    const config = await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      userConfig,
      { command: "build", mode: "production" },
    )

    expect(config).toBeUndefined()
    expect(userConfig).toMatchObject({
      nitro: {
        cloudflare: {
          wrangler: {
            triggers: { crons: ["0 0 * * *"] },
          },
        },
        modules: ["./.vitehub/nitro/schedule/module.mjs"],
        plugins: [".vitehub/nitro/schedule/plugin.ts"],
      },
    })
  })

  it("preserves existing Nitro build hooks while adding schedule Provider Output", async () => {
    const root = await temporaryDirectory("vitehub-schedule-nitro-hooks-")
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "mirror.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '0 4 * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")
    const calls: string[] = []
    const userConfig: Record<string, unknown> = {
      root,
      nitro: {
        hooks: {
          "build:before": () => calls.push("existing"),
        },
      },
    }
    const plugin = hubSchedule()
    const config = await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      userConfig,
      { command: "build", mode: "production" },
    )

    expect(config).toBeUndefined()
    const buildBefore = ((userConfig.nitro as { hooks?: Record<string, unknown> }).hooks?.["build:before"]) as () => void
    buildBefore()

    expect(calls).toEqual(["existing"])
    expect(userConfig).toMatchObject({
      nitro: {
        hooks: { "build:before": buildBefore },
        modules: ["./.vitehub/nitro/schedule/module.mjs"],
        plugins: [".vitehub/nitro/schedule/plugin.ts"],
      },
    })
  })

  it("skips standalone provider bundling when server schedules use Nitro provider output", async () => {
    const root = await temporaryDirectory("vitehub-schedule-nitro-skip-")
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await mkdir(join(root, "dist", "client"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "sync.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '0 4 * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")

    const plugin = hubSchedule()
    await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)({
      root,
    }, { command: "build", mode: "production" })
    await (plugin.configResolved as (config: Record<string, unknown>) => Promise<void>)({
      build: { outDir: "dist/client" },
      command: "build",
      resolve: { alias: [] },
      root,
    })
    await (plugin.buildEnd as (this: never) => Promise<void>).call({} as never)
    expect(existsSync(join(root, ".vitehub", "schedule-generations"))).toBe(false)
    await (plugin.closeBundle as { handler: (this: never) => Promise<void> }).handler.call({} as never)

    expect(existsSync(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"))).toBe(false)
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "provider-registry.js"), "utf8")).resolves.toContain("server/schedules/sync.ts")
  })

  it("does not prepare a Workflow runtime when no schedules are defined", async () => {
    const root = await temporaryDirectory("vitehub-schedule-empty-workflow-")
    const prepareScheduleRuntime = vi.fn(async () => ({
      bundleAlias: {},
      native: false,
      registryFile: join(root, "workflow-registry.js"),
      runtimeModules: { state: "/workflow/runtime/state.js", vercelVite: "/workflow/runtime/vercel-vite.js" },
    }))
    const plugin = hubSchedule()
    await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      { root },
      { command: "build", mode: "production" },
    )
    await (plugin.configResolved as (config: Record<string, unknown>) => Promise<void>)({
      build: { outDir: "dist/client" },
      command: "build",
      plugins: [{ vitehub: { workflow: { prepareScheduleRuntime } } }],
      resolve: { alias: [] },
      root,
    })

    await (plugin.buildEnd as (this: never) => Promise<void>).call({} as never)

    expect(prepareScheduleRuntime).not.toHaveBeenCalled()
  })

  it("keeps suffix standalone output when server schedules use Nitro provider output", async () => {
    const root = await temporaryDirectory("vitehub-schedule-mixed-output-")
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await mkdir(join(root, "src"), { recursive: true })
    await mkdir(join(root, "dist", "client"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "sync.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '0 4 * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")
    await writeFile(join(root, "src", "cleanup.schedule.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '0 0 * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")

    const plugin = hubSchedule()
    const userConfig: Record<string, unknown> = {
      root,
    }
    await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      userConfig,
      { command: "build", mode: "production" },
    )
    await (plugin.configResolved as (config: Record<string, unknown>) => Promise<void>)({
      build: { outDir: "dist/client" },
      command: "build",
      resolve: { alias: [] },
      root,
    })
    await runProviderOutputHooks(plugin)

    expect(userConfig).toMatchObject({
      nitro: {
        cloudflare: {
          wrangler: {
            triggers: { crons: ["0 4 * * *"] },
          },
        },
      },
    })
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.mjs"), "utf8")).resolves.toContain("\"0 4 * * *\"")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.mjs"), "utf8")).resolves.not.toContain("\"0 0 * * *\"")
    await expect(readFile(join(root, ".vitehub", "schedule", "registry.mjs"), "utf8")).resolves.toContain("\"cleanup\"")
    await expect(readFile(join(root, ".vitehub", "schedule", "registry.mjs"), "utf8")).resolves.not.toContain("\"sync\"")
    await expect(readFile(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"), "utf8")).resolves.toContain("\"0 0 * * *\"")
    await expect(readFile(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"), "utf8")).resolves.not.toContain("\"0 4 * * *\"")
    await expect(readFile(join(createDefaultNetlifyOutputRoot(root), "functions", "vitehub-schedule-cleanup.mjs"), "utf8")).resolves.toContain("schedule: \"0 0 * * *\"")
    await expect(readFile(join(createDefaultNetlifyOutputRoot(root), "functions", "vitehub-schedule-sync.mjs"), "utf8")).rejects.toThrow()
  })

  it("keeps suffix Schedule discovery relative to a nested Vite root", async () => {
    const projectRoot = await temporaryDirectory("vitehub-schedule-project-root-")
    const viteRoot = join(projectRoot, "apps", "web")
    await mkdir(join(viteRoot, "src"), { recursive: true })
    await mkdir(join(projectRoot, "apps", "sibling", "src"), { recursive: true })
    await writeFile(join(viteRoot, "src", "cleanup.schedule.ts"), "export default defineSchedule({ cron: '0 0 * * *', handler: () => {} })\n")
    await writeFile(join(projectRoot, "apps", "sibling", "src", "noise.schedule.ts"), "export default defineSchedule({ cron: '0 1 * * *', handler: () => {} })\n")

    const plugin = hubSchedule({ projectRoot })
    await (plugin.config as (config: Record<string, unknown>, env: { command: "build", mode: string }) => unknown)({ root: viteRoot }, { command: "build", mode: "production" })
    await (plugin.configResolved as (config: Record<string, unknown>) => Promise<void>)({ build: { outDir: "dist" }, command: "build", resolve: { alias: [] }, root: viteRoot })
    await runProviderOutputHooks(plugin)

    const registry = await readFile(join(projectRoot, ".vitehub", "schedule", "registry.mjs"), "utf8")
    expect(registry).toContain('"cleanup"')
    expect(registry).not.toContain("noise")
  })

  it("serves a stable lazy registry for discovered schedule files", async () => {
    const root = await temporaryDirectory("vitehub-schedule-vite-")
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "cleanup.schedule.ts"), "export default null\n", "utf8")
    await writeFile(join(root, "src", "reports.schedule.ts"), "export default defineSchedule({ cron: \"0 0 * * *\", handler: () => {} })\n", "utf8")

    const plugin = hubSchedule({ projectRoot: root })
    await resolvePluginConfig(plugin, root)
    const registry = await loadScheduleRegistry(plugin)

    expect(resolveScheduleRegistry(plugin)).toBe("\0#vitehub/schedule/registry")
    expect(registry).toContain("[\"cleanup\"]: async () => import(")
    expect(registry).toContain("[\"reports\"]: async () => import(")
    expect(registry).toContain(`import(${JSON.stringify(join(root, "src", "cleanup.schedule.ts"))})`)
  })

  it("serves server schedules from the stable lazy registry", async () => {
    const root = await temporaryDirectory("vitehub-schedule-registry-server-")
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "sync.ts"), "export default defineSchedule({ cron: \"0 4 * * *\", handler: () => {} })\n", "utf8")

    const plugin = hubSchedule({ providerOutput: false })
    await resolvePluginConfig(plugin, root)
    const registry = await loadScheduleRegistry(plugin)

    expect(registry).toContain(`["sync"]: async () => import(${JSON.stringify(join(root, "server", "schedules", "sync.ts"))})`)
  })

  it("serves an empty registry without special cases", async () => {
    const root = await temporaryDirectory("vitehub-schedule-vite-empty-")
    const plugin = hubSchedule()
    await resolvePluginConfig(plugin, root)

    expect(await loadScheduleRegistry(plugin)).toBe([
      "",
      "const registry = {",
      "}",
      "",
      "export default registry",
      "",
    ].join("\n"))
  })

  describe("cron per host", () => {
    async function createHourlyCleanup(prefix: string) {
      const root = await temporaryDirectory(prefix)
      await mkdir(join(root, "server", "schedules"), { recursive: true })
      await mkdir(join(root, "dist", "client"), { recursive: true })
      await writeFile(join(root, "server", "schedules", "cleanup.ts"), [
        "import { defineSchedule } from '@vite-hub/schedule'",
        "export default defineSchedule({ cron: '0 * * * *', handler: ({ cron }) => { globalThis.cleanupRuns = (globalThis.cleanupRuns ?? 0) + 1; globalThis.cleanupCron = cron } })",
        "",
      ].join("\n"), "utf8")
      return root
    }

    async function buildStandalone(root: string, options: Parameters<typeof hubSchedule>[0]) {
      const plugin = hubSchedule({ projectRoot: root, providerOutput: "standalone", ...options })
      await (plugin.config as (config: Record<string, unknown>, env: { command: "build", mode: string }) => unknown)(
        { root },
        { command: "build", mode: "production" },
      )
      await (plugin.configResolved as (config: Record<string, unknown>) => Promise<void>)({
        build: { outDir: "dist/client" },
        command: "build",
        resolve: { alias: [] },
        root,
      })
      await runProviderOutputHooks(plugin)
      return plugin
    }

    it("writes the build's cron in place of the declared one in standalone output", async () => {
      const root = await createHourlyCleanup("vitehub-schedule-cron-override-")
      const plugin = await buildStandalone(root, { cron: { cleanup: "0 0 * * *" } })

      const vercel = JSON.parse(await readFile(join(createDefaultVercelOutputRoot(root), "config.json"), "utf8"))
      expect(vercel.crons).toEqual([{ path: "/api/vitehub/schedules/vercel/cleanup", schedule: "0 0 * * *" }])
      await expect(readFile(join(createDefaultNetlifyOutputRoot(root), "functions", "vitehub-schedule-cleanup.mjs"), "utf8")).resolves.toContain("schedule: \"0 0 * * *\"")
      const wrangler = JSON.parse(await readFile(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"), "utf8"))
      expect(wrangler.triggers.crons).toEqual(["0 0 * * *"])
      const { default: worker } = await import(pathToFileURL(join(createDefaultCloudflareOutputRoot(root), "index.js")).href)
      const runs = () => (globalThis as { cleanupRuns?: number }).cleanupRuns ?? 0
      const before = runs()
      await worker.scheduled({ cron: "0 * * * *", scheduledTime: Date.now() }, {}, { waitUntil: vi.fn() })
      expect(runs()).toBe(before)
      await worker.scheduled({ cron: "0 0 * * *", scheduledTime: Date.now() }, {}, { waitUntil: vi.fn() })
      expect(runs()).toBe(before + 1)

      const { default: vercelFunction } = await import(pathToFileURL(join(createDefaultVercelOutputRoot(root), "functions", "api", "vitehub", "schedules", "vercel", "cleanup.func", "index.mjs")).href)
      const response = { end: vi.fn(), statusCode: 0 }
      await vercelFunction({ headers: {}, url: "/api/vitehub/schedules/vercel/cleanup" }, response)
      expect(response.statusCode).toBe(204)
      expect((globalThis as { cleanupCron?: string }).cleanupCron).toBe("0 0 * * *")

      const inspector = (plugin.vitehub!.inspect as () => { definitions: Array<{ list: () => Promise<Array<{ fields: unknown[] }>> }> })().definitions[0]!
      const [summary] = await inspector.list()
      expect(summary!.fields).toEqual(expect.arrayContaining([
        { label: "Cron", value: "0 0 * * *" },
        { label: "Declared cron", value: "0 * * * *" },
      ]))
    })

    it("writes the build's cron to Vercel's Nitro output config", async () => {
      const root = await createHourlyCleanup("vitehub-schedule-cron-override-nitro-vercel-")
      await rm(join(root, "server"), { force: true, recursive: true })
      await mkdir(join(root, "src"), { recursive: true })
      await writeFile(join(root, "src", "cleanup.schedule.ts"), "export default defineSchedule({ cron: '0 * * * *', handler: () => {} })\n", "utf8")

      const nitro = await createScheduleNitroConfig({
        command: "build",
        cron: { cleanup: "0 0 * * *" },
        nitro: { preset: "vercel" },
        root,
      })

      expect(nitro).toMatchObject({
        vercel: { config: { crons: [{ path: "/api/vitehub/schedules/vercel/cleanup", schedule: "0 0 * * *" }] } },
      })
    })

    it("registers the build's cron with Nitro's Cloudflare wake and matches triggers to it", async () => {
      const root = await createHourlyCleanup("vitehub-schedule-cron-override-nitro-cloudflare-")
      const userConfig: Record<string, unknown> = { [VITEHUB_NITRO_CONFIG_CONTEXT]: true, root }
      const plugin = hubSchedule({ cron: { cleanup: "0 0 * * *" } })
      await (plugin.config as (config: Record<string, unknown>, env: { command: "build", mode: string }) => unknown)(
        userConfig,
        { command: "build", mode: "production" },
      )

      expect(userConfig).toMatchObject({ nitro: { cloudflare: { wrangler: { triggers: { crons: ["0 0 * * *"] } } } } })
      await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8"))
        .resolves.toContain("executeCloudflareStaticSchedules(event, { cronOverrides: {\"cleanup\":\"0 0 * * *\"}, registry: scheduleRegistry })")
    })

    it("fails the build when the cron names no Schedule", async () => {
      const root = await createHourlyCleanup("vitehub-schedule-cron-override-unknown-")

      await expect(createScheduleNitroConfig({ command: "build", cron: { cleanpu: "0 0 * * *" }, nitro: { preset: "vercel" }, root }))
        .rejects.toMatchObject({ code: "SCHEDULE_B0008", message: expect.stringContaining("names \"cleanpu\", but no Schedule has that name. Schedules: \"cleanup\"") })
    })

    it("fails the build when the Process Runtime would ignore the cron", async () => {
      const root = await createHourlyCleanup("vitehub-schedule-cron-override-process-")

      await expect(createScheduleNitroConfig({ command: "build", cron: { cleanup: "0 0 * * *" }, root, runtime: { driver: "process" } }))
        .rejects.toMatchObject({ code: "SCHEDULE_B0008" })
    })

    it("accepts the cron when host output wakes Static Schedules beside the Process Runtime", async () => {
      const root = await createHourlyCleanup("vitehub-schedule-cron-override-process-split-")

      await expect(createScheduleNitroConfig({ command: "build", cron: { cleanup: "0 0 * * *" }, providerOutput: "nitro", root, runtime: { driver: "process" } }))
        .resolves.toMatchObject({ cloudflare: { wrangler: { triggers: { crons: ["0 0 * * *"] } } } })
      const plugin = await buildStandalone(root, { cron: { cleanup: "0 0 * * *" }, runtime: { driver: "process" } })
      expect(plugin).toBeDefined()
      const vercel = JSON.parse(await readFile(join(createDefaultVercelOutputRoot(root), "config.json"), "utf8"))
      expect(vercel.crons).toEqual([{ path: "/api/vitehub/schedules/vercel/cleanup", schedule: "0 0 * * *" }])
    })
  })
})
