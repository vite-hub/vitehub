import { existsSync } from "node:fs"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { createDefaultCloudflareOutputRoot, createDefaultNetlifyOutputRoot } from "@vite-hub/internal/build/deployment-output"
import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { createScheduleNitroConfig, hubSchedule } from "../src/vite.ts"

async function runProviderOutputHooks(plugin: ReturnType<typeof hubSchedule>) {
  if (typeof plugin.buildEnd !== "function") throw new TypeError("Expected hubSchedule buildEnd hook")
  await plugin.buildEnd.call({} as never)
  if (!plugin.closeBundle || typeof plugin.closeBundle === "function") throw new TypeError("Expected hubSchedule closeBundle object hook")
  await (plugin.closeBundle as { handler: (this: never) => Promise<void> }).handler.call({} as never)
}

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
  it("collects provider import aliases without a Workflow plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-provider-aliases-"))
    const getImportAliases = vi.fn(async () => ({}))
    const plugin = hubSchedule()

    ;(plugin.configResolved as (config: Record<string, unknown>) => void)({
      build: { outDir: "dist" },
      command: "build",
      plugins: [{ vitehub: { providerOutput: { getImportAliases } } }],
      resolve: { alias: [] },
      root,
    })
    await runProviderOutputHooks(plugin)

    expect(getImportAliases).toHaveBeenCalledOnce()
  })

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
    await runProviderOutputHooks(plugin)
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

    expect(config).toBeUndefined()
    expect(userConfig).toMatchObject({
      nitro: {
        cloudflare: {
          wrangler: {
            triggers: { crons: ["0 0 * * *", "*/10 * * * *"] },
          },
        },
        modules: ["./.vitehub/nitro/schedule/module.mjs"],
        plugins: [".vitehub/nitro/schedule/plugin.ts"],
      },
    })
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")).resolves.toContain("cloudflare:scheduled")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")).resolves.toContain("../../schedule/registry.js")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")).resolves.toContain("@vite-hub/schedule/runtime/static")
    const moduleSource = await readFile(join(root, ".vitehub", "nitro", "schedule", "module.mjs"), "utf8")
    expect(moduleSource).toContain("build:before")
    expect(moduleSource).toContain("dedupeCloudflareCrons")
    expect(moduleSource).toContain("\"*/10 * * * *\"")
    expect(moduleSource).not.toContain("import type")
    expect(moduleSource).not.toContain(": Nitro")
    expect(moduleSource).not.toContain(": void")
    expect(moduleSource).not.toContain("cron is string")
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

    expect(config).toBeUndefined()
    expect(userConfig).toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/schedule/plugin.ts"],
      },
    })
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
    expect(pluginSource).toContain("const shutdownSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']")
    expect(pluginSource).toContain("nodeProcess?.prependOnceListener(signal, closeRuntimeOnSignal)")
    expect(pluginSource).toContain("nodeProcess.kill(nodeProcess.pid, signal)")
    expect(pluginSource).not.toContain("setTimeout")
    expect(pluginSource).toContain("nitroApp.hooks.hook('close', closeRuntime)")
    expect(pluginSource).toContain("export default definePlugin((nitroApp) => {")
    expect(pluginSource).not.toContain("definePlugin(async")
    expect(pluginSource).toContain("runtimeScheduleRegistry from \"./runtime-registry.js\"")
    expect(pluginSource).toContain("staticScheduleRegistry from \"./static-registry.js\"")
    expect(pluginSource).toContain("staticRegistry: staticScheduleRegistry")
    expect(pluginSource).not.toContain("cloudflare:scheduled")
    const shutdownStart = pluginSource.indexOf("  const nodeProcess = globalThis.process")
    const shutdownEnd = pluginSource.indexOf("  nitroApp.hooks.hook('request'", shutdownStart)
    expect(shutdownStart).toBeGreaterThan(-1)
    expect(shutdownEnd).toBeGreaterThan(shutdownStart)
    const shutdownJavaScript = pluginSource.slice(shutdownStart, shutdownEnd)
      .replaceAll(/: (?:NodeJS\.Signals(?:\[\])?|Promise<void> \| undefined)/g, "")
    const proof = join(root, "schedule-close.txt")
    const childFile = join(root, "schedule-signal.mjs")
    await writeFile(childFile, [
      "import { writeFile } from 'node:fs/promises'",
      `const proof = ${JSON.stringify(proof)}`,
      "const captureRuntimeError = console.error",
      "const runtimeInstallation = Promise.resolve({ controller: { close: async () => { await writeFile(proof, 'closed') } } })",
      shutdownJavaScript,
      "process.stdout.write('ready')",
      "setInterval(() => {}, 1000)",
    ].join("\n"), "utf8")
    const child = spawn(process.execPath, [childFile], { stdio: ["ignore", "pipe", "pipe"] })
    if (!child.stdout) throw new Error("Expected Schedule signal test stdout.")
    let childStderr = ""
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", chunk => childStderr += chunk)
    const exited = once(child, "exit")
    await Promise.race([
      once(child.stdout, "data"),
      exited.then(([code, signal]) => {
        throw new Error(`Schedule signal child exited before installing listeners: ${code ?? signal}\n${childStderr}`)
      }),
    ])
    child.kill("SIGTERM")
    await expect(exited).resolves.toEqual([null, "SIGTERM"])
    await expect(readFile(proof, "utf8")).resolves.toBe("closed")
    const stalledChildFile = join(root, "schedule-stalled-signal.mjs")
    await writeFile(stalledChildFile, [
      "const captureRuntimeError = console.error",
      "const runtimeInstallation = Promise.resolve({ controller: { close: async () => await new Promise(() => {}) } })",
      shutdownJavaScript,
      "process.stdout.write('ready')",
      "setInterval(() => {}, 1000)",
    ].join("\n"), "utf8")
    const stalledChild = spawn(process.execPath, [stalledChildFile], { stdio: ["ignore", "pipe", "pipe"] })
    if (!stalledChild.stdout) throw new Error("Expected stalled Schedule signal test stdout.")
    const stalledExit = once(stalledChild, "exit")
    await once(stalledChild.stdout, "data")
    stalledChild.kill("SIGTERM")
    const exitedBeforeHostDeadline = await Promise.race([
      stalledExit.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 50)),
    ])
    expect(exitedBeforeHostDeadline).toBe(false)
    stalledChild.kill("SIGKILL")
    await expect(stalledExit).resolves.toEqual([null, "SIGKILL"])
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

    expect(config).toBeUndefined()
    expect(userConfig).toMatchObject({
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
    await runProviderOutputHooks(plugin)
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
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.mjs"), "utf8")).resolves.toContain("\"0 0 * * *\"")
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
    await runProviderOutputHooks(plugin)

    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")).resolves.not.toContain("cloudflare:scheduled")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "static-registry.js"), "utf8")).resolves.not.toContain("src/cleanup.schedule.ts")
    await expect(readFile(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"), "utf8")).resolves.toContain("\"0 0 * * *\"")
    await expect(readFile(join(createDefaultNetlifyOutputRoot(root), "functions", "vitehub-schedule-cleanup.mjs"), "utf8")).resolves.toContain("schedule: \"0 0 * * *\"")
  })

  it("preserves forwarded server directories in standalone Provider Output", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-forwarded-standalone-output-"))
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
    ;(plugin.configResolved as (config: Record<string, unknown>) => void)({
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
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-server-standalone-output-"))
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
    ;(plugin.configResolved as (config: Record<string, unknown>) => void)({
      build: { outDir: "dist/client" },
      command: "build",
      resolve: { alias: [] },
      root,
    })
    await runProviderOutputHooks(plugin)

    await expect(readFile(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"), "utf8")).resolves.toContain("\"0 9 * * *\"")
    await expect(readFile(join(createDefaultNetlifyOutputRoot(root), "functions", "vitehub-schedule-report.mjs"), "utf8")).resolves.toContain("schedule: \"0 9 * * *\"")
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
      modules: ["existing-module", "./.vitehub/nitro/schedule/module.mjs"],
      plugins: [".vitehub/nitro/schedule/plugin.ts"],
    })
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")).resolves.toContain("cloudflare:scheduled")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.mjs"), "utf8")).resolves.toContain("\"*/15 * * * *\"")
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
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.mjs"), "utf8")).rejects.toThrow()
  })

  it("adds standalone schedules to Vercel's Nitro output config", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-vercel-"))
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
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-vercel-auto-"))
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
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-vercel-auto-process-"))
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
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-vercel-env-"))
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
    await runProviderOutputHooks(plugin)

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
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-schedule-project-root-"))
    const viteRoot = join(projectRoot, "apps", "web")
    await mkdir(join(viteRoot, "src"), { recursive: true })
    await mkdir(join(projectRoot, "apps", "sibling", "src"), { recursive: true })
    await writeFile(join(viteRoot, "src", "cleanup.schedule.ts"), "export default defineSchedule({ cron: '0 0 * * *', handler: () => {} })\n")
    await writeFile(join(projectRoot, "apps", "sibling", "src", "noise.schedule.ts"), "export default defineSchedule({ cron: '0 1 * * *', handler: () => {} })\n")

    const plugin = hubSchedule({ projectRoot })
    await (plugin.config as (config: Record<string, unknown>, env: { command: "build", mode: string }) => unknown)({ root: viteRoot }, { command: "build", mode: "production" })
    ;(plugin.configResolved as (config: Record<string, unknown>) => void)({ build: { outDir: "dist" }, command: "build", resolve: { alias: [] }, root: viteRoot })
    await runProviderOutputHooks(plugin)

    const registry = await readFile(join(projectRoot, ".vitehub", "schedule", "registry.mjs"), "utf8")
    expect(registry).toContain('"cleanup"')
    expect(registry).not.toContain("noise")
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
