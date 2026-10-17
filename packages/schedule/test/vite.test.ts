import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { createScheduleNitroConfig, hubSchedule } from "../src/vite.ts"

import type { ScheduleNitroModule } from "../src/internal/nitro.ts"

function resolveScheduleRegistry(plugin: ReturnType<typeof hubSchedule>) {
  return (plugin.resolveId as (id: string, importer?: string, options?: unknown) => unknown)("#vitehub/schedule/registry")
}

async function loadScheduleRegistry(plugin: ReturnType<typeof hubSchedule>) {
  return await (plugin.load as (id: string, options?: unknown) => string | Promise<string>)("\0#vitehub/schedule/registry")
}

async function resolvePluginConfig(plugin: ReturnType<typeof hubSchedule>, root: string) {
  await (plugin.configResolved as (config: { root: string }) => Promise<void>)({ root })
}

async function createProject(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-vite-"))
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true })
    await writeFile(join(root, file), contents, "utf8")
  }
  return root
}

function scheduleModule(nitro: Record<string, unknown> | null): ScheduleNitroModule {
  // SAFETY: Schedule adds its Nitro module object to the `modules` array it returns.
  const module = (nitro?.modules as ScheduleNitroModule[] | undefined)?.find(entry => entry.name === "vitehub:schedule")
  if (!module) throw new TypeError("Expected the vitehub:schedule Nitro module")
  return module
}

function setupModule(module: ScheduleNitroModule, preset: string, rootDir: string) {
  const compiled: Array<() => Promise<void>> = []
  const options = { experimental: {}, handlers: [], plugins: [], preset, rootDir } as Parameters<ScheduleNitroModule["setup"]>[0]["options"]
  module.setup({ hooks: { hook: (_name, handler) => compiled.push(handler) }, options })
  return { compiled, options }
}

const daily = "import { defineSchedule } from '@vite-hub/schedule'\nexport default defineSchedule({ cron: '0 9 * * *', handler: () => {} })\n"
const hourly = "import { defineSchedule } from '@vite-hub/schedule'\nexport default defineSchedule({ cron: '0 * * * *', handler: () => {} })\n"

describe("Vite schedule integration", () => {
  it("runs before framework integrations that read the Nitro config", () => {
    expect(hubSchedule().enforce).toBe("pre")
  })

  it("registers each Static Schedule as a Nitro scheduled task for builds", async () => {
    const root = await createProject({ "server/schedules/daily.ts": daily, "src/cleanup.schedule.ts": hourly })
    const config: Record<string, unknown> = { nitro: { modules: ["user-module"] }, root }
    await (hubSchedule().config as (config: Record<string, unknown>, env: { command: "build", mode: string }) => unknown)(config, { command: "build", mode: "production" })
    const nitro = config.nitro as Record<string, unknown>

    expect(nitro.modules).toEqual(["user-module", expect.objectContaining({ name: "vitehub:schedule" })])
    const { options } = setupModule(scheduleModule(nitro), "node-server", root)
    const task = join(root, ".vitehub", "nitro", "schedule", "task.mjs")
    expect(options.experimental).toEqual({ tasks: true })
    expect(options.tasks).toEqual({
      "vitehub:schedule:cleanup": { description: "ViteHub Static Schedule \"cleanup\" (0 * * * * UTC).", handler: task },
      "vitehub:schedule:daily": { description: "ViteHub Static Schedule \"daily\" (0 9 * * * UTC).", handler: task },
    })
    expect(options.scheduledTasks).toEqual({ "0 * * * *": ["vitehub:schedule:cleanup"], "0 9 * * *": ["vitehub:schedule:daily"] })
    expect(options.handlers).toEqual([])
    expect(options.plugins).toEqual([])
    await expect(readFile(task, "utf8")).resolves.toContain("runScheduleTask(event, scheduleRegistry)")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "registry.js"), "utf8")).resolves.toContain("[\"daily\"]: async () => import(\"../../../server/schedules/daily.ts\")")
  })

  it("keeps one Schedule module when Nitro config is created again", async () => {
    const root = await createProject({ "server/schedules/daily.ts": daily })
    const first = await createScheduleNitroConfig({ command: "build", root })
    const second = await createScheduleNitroConfig({ command: "build", nitro: first, root })

    expect(second?.modules).toHaveLength(1)
    expect(await createScheduleNitroConfig({ command: "serve", root })).toBeNull()
    expect(await createScheduleNitroConfig({ command: "build", root: await createProject({}) })).toBeNull()
  })

  it("adds a Netlify scheduled function that calls the Nitro Schedule route", async () => {
    const root = await createProject({ "server/schedules/daily.ts": daily })
    const { compiled, options } = setupModule(scheduleModule(await createScheduleNitroConfig({ command: "build", root })), "netlify", root)

    expect(options.handlers).toEqual([{ handler: join(root, ".vitehub", "nitro", "schedule", "netlify-handler.mjs"), method: "POST", route: "/_vitehub/schedules/run" }])
    await Promise.all(compiled.map(hook => hook()))
    const wake = await readFile(join(root, ".netlify", "v1", "functions", "vitehub-schedule-daily.mjs"), "utf8")
    expect(wake).toContain("export const config = { schedule: \"0 9 * * *\" }")
    expect(wake).toContain("\"x-vitehub-schedule\": \"daily\"")
    const secret = /process\.env\.CRON_SECRET \|\| "([^"]+)"/.exec(wake)?.[1]
    expect(secret).toBeTruthy()
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "netlify-handler.mjs"), "utf8")).resolves.toContain(secret!)
  })

  it("adds a Deno Deploy plugin that registers Deno.cron", async () => {
    const root = await createProject({ "server/schedules/daily.ts": daily })
    const { options } = setupModule(scheduleModule(await createScheduleNitroConfig({ command: "build", root })), "deno_deploy", root)
    const plugin = join(root, ".vitehub", "nitro", "schedule", "deno-cron.mjs")

    expect(options.plugins).toEqual([plugin])
    const source = await readFile(plugin, "utf8")
    expect(source).toContain("\"cronName\": \"vitehub-0-daily\"")
    expect(source).toContain("Deno.cron(cronName, cron")
  })

  it("discovers project server schedules when the Vite root is nested", async () => {
    const root = await createProject({ "app/src/cleanup.schedule.ts": hourly, "server/schedules/sync.ts": daily, "apps/sibling/src/noise.schedule.ts": hourly })
    const nitro = await createScheduleNitroConfig({ command: "build", projectRoot: root, root: join(root, "app") })
    const { options } = setupModule(scheduleModule(nitro), "node-server", root)

    expect(Object.keys(options.tasks ?? {}).sort()).toEqual(["vitehub:schedule:cleanup", "vitehub:schedule:sync"])
  })

  it("installs Schedule tasks through the Nuxt module", async () => {
    const root = await createProject({ "server/schedules/mirror.ts": "import { defineSchedule } from '@vite-hub/schedule'\nexport default defineSchedule({ cron: '*/15 * * * *', handler: () => {} })\n" })
    const hooks: Array<(nitroConfig: Record<string, unknown>) => Promise<void> | void> = []
    const { default: scheduleNuxt } = await import("../src/nuxt.ts")
    scheduleNuxt({}, { hook: (_name, handler) => hooks.push(handler), options: { dev: false, rootDir: root } })
    const nitroConfig: Record<string, unknown> = {}
    for (const hook of hooks) await hook(nitroConfig)

    const { options } = setupModule(scheduleModule(nitroConfig), "cloudflare-module", root)
    expect(options.scheduledTasks).toEqual({ "*/15 * * * *": ["vitehub:schedule:mirror"] })
  })

  it("invalidates registries for updates under a forwarded server directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-hmr-"))
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
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-hmr-env-"))
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

  it("adds the Schedule dev handler to Nitro only for the Development Server", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-dev-handler-"))
    const serveConfig: Record<string, unknown> = { nitro: { baseURL: "/app/" }, root }
    await (hubSchedule({ projectRoot: root }).config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      serveConfig,
      { command: "serve", mode: "development" },
    )

    expect(serveConfig.nitro).toMatchObject({
      baseURL: "/app/",
      handlers: [{ route: "/_vitehub/schedule/dev" }],
    })
    const handler = (serveConfig.nitro as { handlers?: { handler: string }[] }).handlers?.[0]?.handler
    expect(handler).toMatch(/\.vitehub[\\/]nitro[\\/]schedule[\\/]dev-handlers[\\/][^/\\]+\.ts$/)
    const source = await readFile(handler!, "utf8")
    expect(source).toContain("import { handleScheduleDevRequest as handleViteHubDevRequest } from \"@vite-hub/schedule/runtime/dev\"")
    expect(source).toContain("import viteHubDevContext0 from \"#vitehub/schedule/registry\"")

    const buildConfig: Record<string, unknown> = { root }
    await (hubSchedule({ projectRoot: root }).config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      buildConfig,
      { command: "build", mode: "production" },
    )
    expect(JSON.stringify(buildConfig.nitro ?? {})).not.toContain("dev-handler")
  })

  it("serves a stable lazy registry for discovered schedule files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-vite-"))
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
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-registry-server-"))
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "sync.ts"), "export default defineSchedule({ cron: \"0 4 * * *\", handler: () => {} })\n", "utf8")

    const plugin = hubSchedule()
    await resolvePluginConfig(plugin, root)
    const registry = await loadScheduleRegistry(plugin)

    expect(registry).toContain(`["sync"]: async () => import(${JSON.stringify(join(root, "server", "schedules", "sync.ts"))})`)
  })

  it("serves an empty registry without special cases", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-vite-empty-"))
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
})
