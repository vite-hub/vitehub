import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { createDefaultCloudflareOutputRoot, createDefaultNetlifyOutputRoot } from "@vite-hub/internal/build/deployment-output"
import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { createScheduleNitroConfig, hubSchedule } from "../src/vite.ts"

function resolveScheduleRegistry(plugin: ReturnType<typeof hubSchedule>) {
  return (plugin.resolveId as (id: string, importer?: string, options?: unknown) => unknown)("#vitehub/schedule/registry")
}

function resolveScheduleTargets(plugin: ReturnType<typeof hubSchedule>) {
  return (plugin.resolveId as (id: string, importer?: string, options?: unknown) => unknown)("#vitehub/schedule/targets")
}

async function loadScheduleRegistry(plugin: ReturnType<typeof hubSchedule>) {
  return await (plugin.load as (id: string, options?: unknown) => string | Promise<string>)("\0#vitehub/schedule/registry")
}

async function loadScheduleTargets(plugin: ReturnType<typeof hubSchedule>) {
  return await (plugin.load as (id: string, options?: unknown) => string | Promise<string>)("\0#vitehub/schedule/targets")
}

function resolvePluginConfig(plugin: ReturnType<typeof hubSchedule>, root: string) {
  ;(plugin.configResolved as (config: { root: string }) => void)({ root })
}

describe("Vite schedule integration", () => {
  it("runs before downstream framework integrations that consume Provider Output config", () => {
    const plugin = hubSchedule()

    expect(plugin.enforce).toBe("pre")
  })

  it("invalidates registries for updates under a forwarded server directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-hmr-"))
    const serverDir = join(root, "backend")
    const plugin = hubSchedule()
    await (plugin.config as (config: Record<PropertyKey, unknown>, env: { command: "serve", mode: string }) => unknown)({
      [VITEHUB_SERVER_DIRS]: [serverDir],
      root,
    }, { command: "serve", mode: "development" })
    resolvePluginConfig(plugin, root)
    const registry = {}
    const targets = {}
    const invalidateModule = vi.fn()

    ;(plugin.handleHotUpdate as (context: Record<string, unknown>) => unknown)({
      file: join(serverDir, "schedules", "daily.ts"),
      server: {
        config: { root },
        moduleGraph: {
          getModuleById: (id: string) => id.includes("targets") ? targets : registry,
          invalidateModule,
        },
      },
    })

    expect(invalidateModule).toHaveBeenCalledWith(registry)
    expect(invalidateModule).toHaveBeenCalledWith(targets)
  })

  it("registers runtime-only targets without emitting static provider output", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-runtime-target-"))
    const netlifyRoot = createDefaultNetlifyOutputRoot(root)
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await mkdir(join(netlifyRoot, "functions"), { recursive: true })
    await writeFile(join(netlifyRoot, "functions", "vitehub-schedule-stale.mjs"), "stale\n", "utf8")
    await writeFile(join(root, "server", "schedules", "agent-turn.ts"), [
      "import { defineScheduleTarget } from '@vite-hub/schedule'",
      "export default defineScheduleTarget({ handler: () => {} })",
      "",
    ].join("\n"), "utf8")

    const plugin = hubSchedule()
    const config = await (plugin.config as (config: Record<string, unknown>, env: { command: "build", mode: string }) => unknown)(
      { root },
      { command: "build", mode: "production" },
    )
    expect(config).toBeNull()

    ;(plugin.configResolved as (config: Record<string, unknown>) => void)({
      build: { outDir: "dist" },
      command: "build",
      resolve: { alias: [] },
      root,
    })
    await (plugin.closeBundle as () => Promise<void>)()
    await expect(loadScheduleRegistry(plugin)).resolves.toContain("server/schedules/agent-turn.ts")
    await expect(loadScheduleTargets(plugin)).resolves.toContain('"agent-turn"')
    expect(existsSync(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"))).toBe(false)
    await expect(readFile(join(netlifyRoot, "functions", "vitehub-schedule-stale.mjs"), "utf8")).rejects.toThrow()
  })

  it("contributes discovered schedules to the in-flight Nitro config before framework plugins consume it", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-nitro-config-"))
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "mirror.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '*/10 * * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")

    const userConfig: Record<string, unknown> = {
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

    expect(config).toMatchObject({
      nitro: {
        cloudflare: {
          wrangler: {
            triggers: { crons: ["0 0 * * *", "*/10 * * * *"] },
          },
        },
        modules: ["./.vitehub/nitro/schedule/module.ts"],
        plugins: [".vitehub/nitro/schedule/plugin.ts"],
      },
    })
    expect(userConfig).toMatchObject({
      nitro: {
        cloudflare: {
          wrangler: {
            triggers: { crons: ["0 0 * * *", "*/10 * * * *"] },
          },
        },
        modules: ["./.vitehub/nitro/schedule/module.ts"],
        plugins: [".vitehub/nitro/schedule/plugin.ts"],
      },
    })
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")).resolves.toContain("cloudflare:scheduled")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")).resolves.toContain("../../schedule/registry.js")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")).resolves.toContain("@vite-hub/schedule/runtime/static")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.ts"), "utf8")).resolves.toContain("build:before")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.ts"), "utf8")).resolves.toContain("dedupeCloudflareCrons")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.ts"), "utf8")).resolves.toContain("\"*/10 * * * *\"")
    await expect(readFile(join(root, ".vitehub", "schedule", "registry.js"), "utf8")).resolves.toContain("\"mirror\": async () => import(")
    await expect(readFile(join(root, ".vitehub", "schedule", "registry.d.ts"), "utf8")).resolves.toContain("ScheduleRegistryDefinition")
  })

  it("installs an explicit Process Runtime through generated Nitro wiring", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-process-runtime-"))
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "report.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '*/10 * * * *', allowRuntimeSchedules: true, handler: () => {} })",
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

    expect(config).toEqual({
      nitro: {
        plugins: [".vitehub/nitro/schedule/plugin.ts"],
      },
    })
    expect(userConfig).toMatchObject(config as Record<string, unknown>)
    expect(userConfig).not.toHaveProperty("nitro.cloudflare")
    expect(userConfig).not.toHaveProperty("nitro.modules")

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")
    expect(pluginSource).toContain("createProcessScheduleWakeDriver")
    expect(pluginSource).toContain("installScheduleRuntime")
    expect(pluginSource).toContain("createKVRuntimeScheduleStore")
    expect(pluginSource).toContain("createKVScheduleRunStore")
    expect(pluginSource).not.toContain("from \"@vite-hub/kv\"")
    expect(pluginSource).not.toContain("kvStore: createScheduleKVStorage")
    expect(pluginSource).toContain("\"prefix\": \"brujula:schedule\"")
    expect(pluginSource).toContain("\"concurrency\": 2")
    expect(pluginSource).toContain("\"intervalMs\": 5000")
    expect(pluginSource).toContain("nitroApp.captureError")
    expect(pluginSource).toContain("nitroApp.hooks.hook('close'")
    expect(pluginSource).toContain("nitroApp.hooks.hook('request'")
    expect(pluginSource).not.toContain("nitroApp.fetch")
    expect(pluginSource).not.toContain("h3App")
    expect(pluginSource).toContain("const result = await runtimeInstallation")
    expect(pluginSource).toContain("if ('error' in result) throw result.error")
    expect(pluginSource).toContain("if ('controller' in result) await result.controller.close()")
    expect(pluginSource).toContain("export default definePlugin((nitroApp) => {")
    expect(pluginSource).not.toContain("definePlugin(async")
    expect(pluginSource).toContain("runtimeScheduleRegistry from \"./runtime-registry.js\"")
    expect(pluginSource).toContain("staticScheduleRegistry from \"./static-registry.js\"")
    expect(pluginSource).toContain("staticRegistry: staticScheduleRegistry")
    expect(pluginSource).not.toContain("cloudflare:scheduled")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "runtime-registry.js"), "utf8")).resolves.toContain("server/schedules/report.ts")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "static-registry.js"), "utf8")).resolves.toContain("server/schedules/report.ts")
    resolvePluginConfig(plugin, root)
    expect(resolveScheduleRegistry(plugin)).toBe("\0#vitehub/schedule/registry")
    await expect(loadScheduleRegistry(plugin)).resolves.toContain("server/schedules/report.ts")
  })

  it("installs an explicit Process Runtime with an empty canonical registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-empty-process-runtime-"))
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

    expect(config).toEqual({
      nitro: {
        plugins: [".vitehub/nitro/schedule/plugin.ts"],
      },
    })
    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")
    expect(pluginSource).toContain("runtimeScheduleRegistry from \"./runtime-registry.js\"")
    expect(pluginSource).toContain("staticScheduleRegistry from \"./static-registry.js\"")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "runtime-registry.js"), "utf8")).resolves.toContain("const registry = {")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "static-registry.js"), "utf8")).resolves.toContain("const registry = {")
    resolvePluginConfig(plugin, root)
    expect(resolveScheduleRegistry(plugin)).toBe("\0#vitehub/schedule/registry")
    await expect(loadScheduleRegistry(plugin)).resolves.toContain("const registry = {")
  })

  it("lets the Process Runtime own Static Schedule execution when configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-process-static-"))
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await mkdir(join(root, "src"), { recursive: true })
    await mkdir(join(root, "dist", "client"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "report.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '*/10 * * * *', allowRuntimeSchedules: true, handler: () => {} })",
      "",
    ].join("\n"), "utf8")
    await writeFile(join(root, "src", "cleanup.schedule.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '0 0 * * *', allowRuntimeSchedules: true, handler: () => {} })",
      "",
    ].join("\n"), "utf8")
    await writeFile(join(root, "server", "schedules", "agent-turn.ts"), [
      "import { defineScheduleTarget } from '@vite-hub/schedule'",
      "export default defineScheduleTarget({ handler: () => {} })",
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
    expect(pluginSource).toContain("installScheduleRuntime")
    expect(pluginSource).toContain("runtimeScheduleRegistry from \"./runtime-registry.js\"")
    expect(pluginSource).toContain("staticScheduleRegistry from \"./static-registry.js\"")
    const generatedRuntimeRegistry = await readFile(join(root, ".vitehub", "nitro", "schedule", "runtime-registry.js"), "utf8")
    const generatedStaticRegistry = await readFile(join(root, ".vitehub", "nitro", "schedule", "static-registry.js"), "utf8")
    resolvePluginConfig(plugin, root)
    const runtimeRegistry = await loadScheduleRegistry(plugin)
    await expect(readFile(join(root, ".vitehub", "schedule", "registry.js"), "utf8")).rejects.toThrow()
    expect(runtimeRegistry).toContain("server/schedules/report.ts")
    expect(runtimeRegistry).toContain("src/cleanup.schedule.ts")
    expect(runtimeRegistry).toContain("server/schedules/agent-turn.ts")
    expect(generatedRuntimeRegistry).toContain("server/schedules/report.ts")
    expect(generatedRuntimeRegistry).toContain("src/cleanup.schedule.ts")
    expect(generatedRuntimeRegistry).toContain("server/schedules/agent-turn.ts")
    expect(generatedStaticRegistry).toContain("server/schedules/report.ts")
    expect(generatedStaticRegistry).toContain("src/cleanup.schedule.ts")
    expect(generatedStaticRegistry).not.toContain("server/schedules/agent-turn.ts")
    ;(plugin.configResolved as (config: Record<string, unknown>) => void)({
      build: { outDir: "dist/client" },
      command: "build",
      resolve: { alias: [] },
      root,
    })
    await (plugin.closeBundle as () => Promise<void>)()
    expect(existsSync(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"))).toBe(false)
    await expect(readFile(join(createDefaultNetlifyOutputRoot(root), "functions", "vitehub-schedule-cleanup.mjs"), "utf8")).rejects.toThrow()
  })

  it("honors explicit Nitro Provider Wake output with the Process Runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-process-nitro-output-"))
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
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.ts"), "utf8")).resolves.toContain("\"0 0 * * *\"")
  })

  it("honors explicit standalone Provider Wake output with the Process Runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-process-standalone-output-"))
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
    ;(plugin.configResolved as (config: Record<string, unknown>) => void)({
      build: { outDir: "dist/client" },
      command: "build",
      resolve: { alias: [] },
      root,
    })
    await (plugin.closeBundle as () => Promise<void>)()

    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")).resolves.not.toContain("cloudflare:scheduled")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "static-registry.js"), "utf8")).resolves.not.toContain("src/cleanup.schedule.ts")
    await expect(readFile(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"), "utf8")).resolves.toContain("\"0 0 * * *\"")
    await expect(readFile(join(createDefaultNetlifyOutputRoot(root), "functions", "vitehub-schedule-cleanup.mjs"), "utf8")).resolves.toContain("schedule: \"0 0 * * *\"")
  })

  it("writes a resolvable Process Runtime registry for direct Nitro config integration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-direct-nitro-process-"))
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "report.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '0 9 * * *', allowRuntimeSchedules: true, handler: () => {} })",
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
    expect(pluginSource).toContain("runtimeScheduleRegistry from \"./runtime-registry.js\"")
    expect(pluginSource).toContain("staticScheduleRegistry from \"./static-registry.js\"")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "runtime-registry.js"), "utf8")).resolves.toContain("server/schedules/report.ts")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "static-registry.js"), "utf8")).resolves.toContain("server/schedules/report.ts")
  })

  it("does not infer a Process Runtime from Nitro or discovered definitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-no-process-runtime-"))
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "report.ts"), "export default defineSchedule({ cron: '* * * * *', handler: () => {} })\n", "utf8")

    const plugin = hubSchedule()
    await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      { root },
      { command: "serve", mode: "development" },
    )

    const pluginSource = await readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")
    expect(pluginSource).not.toContain("installScheduleRuntime")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "runtime-registry.js"), "utf8")).rejects.toThrow()
  })

  it("rejects invalid Process Runtime options before generating Nitro code", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-invalid-process-"))
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

  it("installs Schedule Provider Wake through the Nuxt module", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-nuxt-"))
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "mirror.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '*/15 * * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")

    const { default: scheduleNuxt } = await import("../src/nuxt.ts")
    let nitroConfigHook: ((nitroConfig: Record<string, unknown>) => void | Promise<void>) | undefined
    const nuxt = {
      hook(name: "nitro:config", handler: (nitroConfig: Record<string, unknown>) => void | Promise<void>) {
        if (name === "nitro:config") nitroConfigHook = handler
      },
      options: {
        dev: false,
        rootDir: root,
        srcDir: root,
        vite: {} as { plugins?: unknown[] },
      },
    }

    scheduleNuxt({}, nuxt)

    expect(nuxt.options.vite.plugins).toEqual([
      expect.objectContaining({ name: "@vite-hub/schedule/vite" }),
    ])
    expect(nitroConfigHook).toBeDefined()

    const nitroConfig: Record<string, unknown> = {
      cloudflare: {
        wrangler: {
          triggers: { crons: ["0 0 * * *"] },
        },
      },
      modules: ["existing-module"],
    }
    await nitroConfigHook?.(nitroConfig)

    expect(nitroConfig).toMatchObject({
      cloudflare: {
        wrangler: {
          triggers: { crons: ["0 0 * * *", "*/15 * * * *"] },
        },
      },
      modules: ["existing-module", "./.vitehub/nitro/schedule/module.ts"],
      plugins: [".vitehub/nitro/schedule/plugin.ts"],
    })
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")).resolves.toContain("cloudflare:scheduled")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.ts"), "utf8")).resolves.toContain("\"*/15 * * * *\"")
  })

  it("discovers project server schedules when the Vite root is nested", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-nested-root-"))
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
    resolvePluginConfig(plugin, appRoot)
    const registry = await loadScheduleRegistry(plugin)

    expect(config).toMatchObject({
      nitro: {
        cloudflare: {
          wrangler: {
            triggers: { crons: ["0 4 * * *"] },
          },
        },
        modules: ["./.vitehub/nitro/schedule/module.ts"],
        plugins: [".vitehub/nitro/schedule/plugin.ts"],
      },
    })
    expect(userConfig).toMatchObject({
      nitro: {
        cloudflare: {
          wrangler: {
            triggers: { crons: ["0 4 * * *"] },
          },
        },
        modules: ["./.vitehub/nitro/schedule/module.ts"],
        plugins: [".vitehub/nitro/schedule/plugin.ts"],
      },
    })
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")).resolves.toContain("cloudflare:scheduled")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.ts"), "utf8")).resolves.toContain("\"0 4 * * *\"")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.ts"), "utf8")).resolves.not.toContain("\"0 0 * * *\"")
    await expect(readFile(join(appRoot, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")).rejects.toThrow()
    expect(registry).toContain("\"cleanup\": async () => import(")
    expect(registry).toContain("\"sync\": async () => import(")
    expect(registry).toContain("../../app/src/cleanup.schedule.ts")
    expect(registry).toContain("../../server/schedules/sync.ts")
  })

  it("does not install Nitro plugin output for suffix-only standalone schedules by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-standalone-"))
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
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.ts"), "utf8")).rejects.toThrow()
  })

  it("can force Nitro plugin output for suffix schedules", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-force-nitro-"))
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

    expect(config).toMatchObject({
      nitro: {
        cloudflare: {
          wrangler: {
            triggers: { crons: ["0 0 * * *"] },
          },
        },
        modules: ["./.vitehub/nitro/schedule/module.ts"],
        plugins: [".vitehub/nitro/schedule/plugin.ts"],
      },
    })
    expect(userConfig).toMatchObject({
      nitro: {
        cloudflare: {
          wrangler: {
            triggers: { crons: ["0 0 * * *"] },
          },
        },
        modules: ["./.vitehub/nitro/schedule/module.ts"],
        plugins: [".vitehub/nitro/schedule/plugin.ts"],
      },
    })
  })

  it("preserves existing Nitro build hooks while adding schedule Provider Output", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-nitro-hooks-"))
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

    expect(config).toMatchObject({
      nitro: {
        hooks: { "build:before": expect.any(Function) },
        modules: ["./.vitehub/nitro/schedule/module.ts"],
        plugins: [".vitehub/nitro/schedule/plugin.ts"],
      },
    })
    const buildBefore = ((userConfig.nitro as { hooks?: Record<string, unknown> }).hooks?.["build:before"]) as () => void
    buildBefore()

    expect(calls).toEqual(["existing"])
    expect(userConfig).toMatchObject({
      nitro: {
        hooks: { "build:before": buildBefore },
        modules: ["./.vitehub/nitro/schedule/module.ts"],
        plugins: [".vitehub/nitro/schedule/plugin.ts"],
      },
    })
  })

  it("skips standalone provider bundling when server schedules use Nitro provider output", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-nitro-skip-"))
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
    ;(plugin.configResolved as (config: Record<string, unknown>) => void)({
      build: { outDir: "dist/client" },
      command: "build",
      resolve: { alias: [] },
      root,
    })
    await (plugin.closeBundle as () => Promise<void>)()

    expect(existsSync(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"))).toBe(false)
  })

  it("keeps suffix standalone output when server schedules use Nitro provider output", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-mixed-output-"))
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
    ;(plugin.configResolved as (config: Record<string, unknown>) => void)({
      build: { outDir: "dist/client" },
      command: "build",
      resolve: { alias: [] },
      root,
    })
    await (plugin.closeBundle as () => Promise<void>)()

    expect(userConfig).toMatchObject({
      nitro: {
        cloudflare: {
          wrangler: {
            triggers: { crons: ["0 4 * * *"] },
          },
        },
      },
    })
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.ts"), "utf8")).resolves.toContain("\"0 4 * * *\"")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.ts"), "utf8")).resolves.not.toContain("\"0 0 * * *\"")
    await expect(readFile(join(root, ".vitehub", "schedule", "registry.mjs"), "utf8")).resolves.toContain("\"cleanup\"")
    await expect(readFile(join(root, ".vitehub", "schedule", "registry.mjs"), "utf8")).resolves.not.toContain("\"sync\"")
    await expect(readFile(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"), "utf8")).resolves.toContain("\"0 0 * * *\"")
    await expect(readFile(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"), "utf8")).resolves.not.toContain("\"0 4 * * *\"")
    await expect(readFile(join(createDefaultNetlifyOutputRoot(root), "functions", "vitehub-schedule-cleanup.mjs"), "utf8")).resolves.toContain("schedule: \"0 0 * * *\"")
    await expect(readFile(join(createDefaultNetlifyOutputRoot(root), "functions", "vitehub-schedule-sync.mjs"), "utf8")).rejects.toThrow()
  })

  it("serves a stable lazy registry for discovered schedule files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-vite-"))
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "cleanup.schedule.ts"), "export default null\n", "utf8")
    await writeFile(join(root, "src", "reports.schedule.ts"), "export default defineSchedule({ cron: \"0 0 * * *\", handler: () => {} })\n", "utf8")

    const plugin = hubSchedule({ projectRoot: root })
    resolvePluginConfig(plugin, root)
    const registry = await loadScheduleRegistry(plugin)

    expect(resolveScheduleRegistry(plugin)).toBe("\0#vitehub/schedule/registry")
    expect(registry).toContain("\"cleanup\": async () => import(")
    expect(registry).toContain("\"reports\": async () => import(")
    expect(registry).toContain("../../src/cleanup.schedule.ts")
  })

  it("serves server schedules from the stable lazy registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-registry-server-"))
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "sync.ts"), "export default defineSchedule({ cron: \"0 4 * * *\", handler: () => {} })\n", "utf8")

    const plugin = hubSchedule({ providerOutput: false })
    resolvePluginConfig(plugin, root)
    const registry = await loadScheduleRegistry(plugin)

    expect(registry).toContain("\"sync\": async () => import(")
    expect(registry).toContain("../../server/schedules/sync.ts")
  })

  it("serves generated runtime schedule target names behind a stable import", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-targets-"))
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "cleanup.schedule.ts"), "export default defineSchedule({ cron: \"0 0 * * *\", handler: () => {} })\n", "utf8")
    await writeFile(join(root, "src", "reports.schedule.ts"), "export default defineSchedule({ cron: \"0 0 * * *\", handler: () => {}, allowRuntimeSchedules: true })\n", "utf8")

    const plugin = hubSchedule()
    resolvePluginConfig(plugin, root)
    const targets = await loadScheduleTargets(plugin)

    expect(resolveScheduleTargets(plugin)).toBe("\0#vitehub/schedule/targets")
    expect(targets).toContain("export const scheduleTargetNames = [\"reports\"];")
    expect(targets).not.toContain("export type")
    expect(targets).not.toContain("\"cleanup\"")
  })

  it("discovers quoted runtime schedule opt-in keys and ignores commented opt-ins", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-targets-quoted-"))
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "commented.schedule.ts"), "export default defineSchedule({ cron: \"0 0 * * *\", handler: () => {}, /* allowRuntimeSchedules: true */ })\n", "utf8")
    await writeFile(join(root, "src", "quoted.schedule.ts"), "export default defineSchedule({ cron: \"0 0 * * *\", handler: () => {}, \"allowRuntimeSchedules\": true })\n", "utf8")

    const plugin = hubSchedule()
    resolvePluginConfig(plugin, root)
    const targets = await loadScheduleTargets(plugin)

    expect(targets).toContain("export const scheduleTargetNames = [\"quoted\"];")
    expect(targets).not.toContain("\"commented\"")
  })

  it("serves an empty registry without special cases", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-vite-empty-"))
    const plugin = hubSchedule()
    resolvePluginConfig(plugin, root)

    expect(await loadScheduleRegistry(plugin)).toBe([
      "",
      "const registry = {",
      "}",
      "",
      "export default registry",
      "",
    ].join("\n"))
  })
})
