import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createDefaultCloudflareOutputRoot, createDefaultNetlifyOutputRoot } from "@vite-hub/internal/build/deployment-output"
import { VITEHUB_NITRO_CONFIG_CONTEXT } from "@vite-hub/internal/build/vite"

import { collectScheduleContributions } from "../src/contributions.ts"
import { discoverScheduleDefinitions } from "../src/discovery.ts"
import { inspectScheduleDefinitions } from "../src/inspect.ts"
import { createScheduleNitroConfig, hubSchedule } from "../src/vite.ts"

import type { CollectedScheduleContribution, ScheduleContributingPlugin } from "../src/vite.ts"

const tempDirs: string[] = []
const contentPlugin = "@vite-hub/content/vite"
const reason = "server/content.ts uses the cms preset, which publishes scheduled documents."

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

/** A project with one file Schedule and one Definition module that a package generates under `.vitehub/`. */
async function createRoot(options: { cron?: string, definition?: string, file?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-contributions-"))
  tempDirs.push(root)
  await mkdir(join(root, "dist", "client"), { recursive: true })
  if (options.file !== false) {
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "report.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "export default defineSchedule({ cron: '0 9 * * *', handler: () => {} })",
      "",
    ].join("\n"), "utf8")
  }
  const definition = join(root, ".vitehub", "content", "publish-schedule.ts")
  await mkdir(join(root, ".vitehub", "content"), { recursive: true })
  await writeFile(definition, options.definition ?? [
    "import { defineSchedule } from '@vite-hub/schedule'",
    `export default defineSchedule({ cron: '${options.cron ?? "*/5 * * * *"}', manual: true, handler: () => ({ published: 0 }) })`,
    "",
  ].join("\n"), "utf8")
  return { definition, root }
}

function contributor(schedules: NonNullable<ScheduleContributingPlugin["vitehub"]>["schedules"], name = contentPlugin): ScheduleContributingPlugin {
  return { name, vitehub: { schedules } }
}

function publishContributor(module: string) {
  return contributor([{ definition: { module }, name: "content/publish", reason }])
}

function collected(name: string, module: string, plugin = contentPlugin): CollectedScheduleContribution {
  return { definition: { export: "default", module }, name, plugin }
}

type ConfigHook = (config: Record<PropertyKey, unknown>, env: { command: "build" | "serve", mode: string }) => unknown

async function runProviderOutputHooks(plugin: ReturnType<typeof hubSchedule>) {
  await (plugin.buildEnd as (this: never) => Promise<void>).call({} as never)
  await (plugin.closeBundle as { handler: (this: never) => Promise<void> }).handler.call({} as never)
}

async function resolvePlugin(plugin: ReturnType<typeof hubSchedule>, root: string, plugins: unknown[]) {
  await (plugin.configResolved as (config: Record<string, unknown>) => Promise<void>)({
    build: { outDir: "dist/client" },
    command: "build",
    plugins,
    resolve: { alias: [] },
    root,
  })
}

const context = { projectRoot: "/app", root: "/app" }

describe("collectScheduleContributions", () => {
  it("collects static and factory contributions from nested plugin options", async () => {
    const factory = vi.fn(() => [{ definition: { module: "/app/.vitehub/content/publish.ts" }, name: "content/publish", reason }])
    const contributions = await collectScheduleContributions([
      { name: "unrelated" },
      [contributor([{ definition: { module: "/abs/digest.ts" }, name: "digest" }], "digest/vite"), [contributor(factory)]],
      false,
    ], { ...context, serverDirs: ["/app/server"] })

    expect(factory).toHaveBeenCalledWith({ projectRoot: "/app", root: "/app", serverDirs: ["/app/server"] })
    expect(contributions).toEqual([
      { ...collected("content/publish", "/app/.vitehub/content/publish.ts"), reason },
      collected("digest", "/abs/digest.ts", "digest/vite"),
    ])
  })

  it("collects contributions from promised and nested promised plugin options", async () => {
    const plugin = contributor([{ definition: { module: "/abs/promised.ts" }, name: "promised" }], "promised/vite")

    await expect(collectScheduleContributions([Promise.resolve([Promise.resolve(plugin)])], context)).resolves.toEqual([
      collected("promised", "/abs/promised.ts", "promised/vite"),
    ])
  })

  it("keeps one copy of the same contribution from two instances of one plugin", async () => {
    const plugin = () => contributor([{ definition: { module: "/abs/publish.ts" }, name: "content/publish" }])

    await expect(collectScheduleContributions([plugin(), plugin()], context))
      .resolves.toEqual([collected("content/publish", "/abs/publish.ts")])
  })

  it("accepts a file: URL as the Definition module", async () => {
    await expect(collectScheduleContributions([contributor([{ definition: { module: pathToFileURL("/abs/publish.ts").href }, name: "content/publish" }])], context))
      .resolves.toEqual([collected("content/publish", "/abs/publish.ts")])
  })

  it("rejects two plugins that contribute different Definitions with one name", async () => {
    await expect(collectScheduleContributions([
      contributor([{ definition: { module: "/abs/a.ts" }, name: "content/publish" }], "a/vite"),
      contributor([{ definition: { module: "/abs/b.ts" }, name: "content/publish" }], "b/vite"),
    ], context)).rejects.toMatchObject({
      code: "SCHEDULE_B0006",
      message: expect.stringContaining([
        "Schedule \"content/publish\" is contributed more than once:",
        "  - /abs/a.ts from plugin \"a/vite\"",
        "  - /abs/b.ts from plugin \"b/vite\"",
      ].join("\n")),
    })
  })

  it.each([
    [{ definition: { module: "./publish.ts" }, name: "content/publish" }, "`definition.module` of Schedule \"content/publish\" is relative"],
    [{ definition: { module: "@vite-hub/content/schedule" }, name: "content/publish" }, "`definition.module` of Schedule \"content/publish\" must be an absolute file path or a file: URL"],
    [{ definition: { export: "publish", module: "/abs/publish.ts" }, name: "content/publish" }, "Schedule \"content/publish\" uses `definition.export: \"publish\"`. Schedule Definitions must be the default export"],
    [{ name: "content/publish" }, "Schedule \"content/publish\" needs `definition: { module, export? }`"],
    [{ definition: "/abs/publish.ts", name: "content/publish" }, "Schedule \"content/publish\" needs `definition: { module, export? }`"],
    [{ definition: { module: "/abs/publish.ts" }, name: "" }, "`name` must be a non-empty string"],
    [{ definition: { module: "/abs/publish.ts" }, name: "content publish" }, "Schedule \"content publish\": `name` must be letters"],
    [{ definition: { module: "/abs/publish.ts" }, name: "content/publish", reason: "" }, "`reason` of Schedule \"content/publish\" must be a non-empty string"],
    ["content/publish", "expected { name, definition: { module, export? }, reason? }"],
  ])("rejects an invalid contribution %#", async (contribution, message) => {
    // SAFETY: Each case passes invalid input that the collector must reject at runtime.
    const invalid = contribution as unknown as CollectedScheduleContribution
    await expect(collectScheduleContributions([contributor([invalid])], context)).rejects.toMatchObject({
      code: "SCHEDULE_B0007",
      message: expect.stringContaining(`Plugin "${contentPlugin}" contributed an invalid Schedule: ${message}`),
    })
  })

  it("rejects contributions that are not an array", async () => {
    await expect(collectScheduleContributions([contributor(() => ({}) as never)], context)).rejects.toMatchObject({
      code: "SCHEDULE_B0007",
      message: expect.stringContaining("`vitehub.schedules` must be an array or a function that returns one."),
    })
  })

  it.each([null, false, 0, "", undefined])("rejects an explicitly invalid schedules value: %p", async (schedules) => {
    await expect(collectScheduleContributions([{ name: contentPlugin, vitehub: { schedules: schedules as never } }], context)).rejects.toMatchObject({
      code: "SCHEDULE_B0007",
      message: expect.stringContaining("`vitehub.schedules` must be an array or a function that returns one."),
    })
  })
})

describe("discoverScheduleDefinitions contributions", () => {
  it("merges contributed Definitions with discovered files and reads their options from source", async () => {
    const { definition, root } = await createRoot()

    expect(discoverScheduleDefinitions({
      contributions: [{ ...collected("content/publish", definition), reason }],
      rootDir: root,
    })).toEqual([
      {
        allowRuntimeSchedules: false,
        contributor: contentPlugin,
        handler: definition,
        manual: true,
        name: "content/publish",
        reason,
        source: "vite-plugin-contribution",
      },
      expect.objectContaining({ handler: join(root, "server", "schedules", "report.ts"), name: "report", source: "server-schedules" }),
    ])
  })

  it("fails when a contribution uses the name of a file Schedule and names both sources", async () => {
    const { definition, root } = await createRoot()

    expect(() => discoverScheduleDefinitions({
      contributions: [collected("report", definition)],
      rootDir: root,
    })).toThrow(expect.objectContaining({
      code: "SCHEDULE_B0006",
      message: expect.stringContaining([
        "Schedule \"report\" is defined more than once:",
        `  - ${join(root, "server", "schedules", "report.ts")}`,
        `  - ${definition} from plugin "${contentPlugin}"`,
        "Rename or remove one definition.",
      ].join("\n")),
    }))
  })

  it("fails when the contributed Definition module does not exist", async () => {
    const { root } = await createRoot()
    const definition = join(root, ".vitehub", "content", "missing.ts")

    expect(() => discoverScheduleDefinitions({ contributions: [collected("content/publish", definition)], rootDir: root }))
      .toThrow(expect.objectContaining({ code: "SCHEDULE_B0007", message: expect.stringContaining(`${definition} from plugin "${contentPlugin}" adds Schedule "content/publish", but the Definition module does not exist.`) }))
  })

  it("fails when the contributed module has no default export of defineSchedule()", async () => {
    const { definition, root } = await createRoot({ definition: "export const publish = { cron: '* * * * *' }\n" })

    expect(() => discoverScheduleDefinitions({ contributions: [collected("content/publish", definition)], rootDir: root }))
      .toThrow(expect.objectContaining({ code: "SCHEDULE_B0005", message: expect.stringContaining("has no default export of defineSchedule() or defineScheduleTarget()") }))
  })
})

describe("contributed Schedules on every host", () => {
  it("adds contributed crons to Cloudflare Cron Triggers through the generated Nitro wake plugin", async () => {
    const { definition, root } = await createRoot()
    const userConfig: Record<PropertyKey, unknown> = {
      [VITEHUB_NITRO_CONFIG_CONTEXT]: true,
      nitro: { cloudflare: { wrangler: { triggers: { crons: ["0 0 * * *"] } } } },
      plugins: [[publishContributor(definition)]],
      root,
    }

    await (hubSchedule().config as ConfigHook)(userConfig, { command: "build", mode: "production" })

    expect(userConfig).toMatchObject({
      nitro: {
        cloudflare: { wrangler: { triggers: { crons: ["0 0 * * *", "*/5 * * * *", "0 9 * * *"] } } },
        plugins: [join(root, ".vitehub/nitro/schedule/plugin.ts")],
      },
    })
    const registry = await readFile(join(root, ".vitehub", "nitro", "schedule", "provider-registry.js"), "utf8")
    expect(registry).toContain("[\"content/publish\"]: async () => import(\"../../content/publish-schedule.ts\")")
    expect(registry).toContain("[\"report\"]: async () => import(")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")).resolves.toContain("[\"content/publish\",\"report\"]")
  })

  it("adds contributed crons to the Vercel cron config", async () => {
    const { definition, root } = await createRoot()

    const nitro = await createScheduleNitroConfig({
      command: "build",
      nitro: { preset: "vercel" },
      plugins: [publishContributor(definition)],
      providerOutput: "standalone",
      root,
    })

    expect(nitro).toMatchObject({
      vercel: {
        config: {
          crons: [
            { path: "/api/vitehub/schedules/vercel/content/publish", schedule: "*/5 * * * *" },
            { path: "/api/vitehub/schedules/vercel/report", schedule: "0 9 * * *" },
          ],
        },
      },
    })
  })

  it("emits contributed Schedules in standalone Cloudflare, Vercel, and Netlify output", async () => {
    const { definition, root } = await createRoot({ file: false })
    const plugins = [publishContributor(definition)]
    const plugin = hubSchedule({ projectRoot: root, providerOutput: "standalone" })

    await (plugin.config as ConfigHook)({ plugins, root }, { command: "build", mode: "production" })
    await resolvePlugin(plugin, root, plugins)
    await runProviderOutputHooks(plugin)

    await expect(readFile(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"), "utf8")).resolves.toContain("\"*/5 * * * *\"")
    await expect(readFile(join(createDefaultNetlifyOutputRoot(root), "functions", "vitehub-schedule-content_publish.mjs"), "utf8")).resolves.toContain("schedule: \"*/5 * * * *\"")
    const vercel = JSON.parse(await readFile(join(root, ".vercel", "output", "config.json"), "utf8"))
    expect(vercel.crons).toContainEqual({ path: "/api/vitehub/schedules/vercel/content/publish", schedule: "*/5 * * * *" })
  })

  it("registers contributed Schedules in the Node Process Runtime registries", async () => {
    const { definition, root } = await createRoot()
    const userConfig: Record<PropertyKey, unknown> = { plugins: [publishContributor(definition)], root }

    await (hubSchedule({ providerOutput: false, runtime: { driver: "process" } }).config as ConfigHook)(userConfig, { command: "build", mode: "production" })

    for (const registry of ["runtime-registry.js", "static-registry.js"]) {
      const contents = await readFile(join(root, ".vitehub", "nitro", "schedule", registry), "utf8")
      expect(contents).toContain("[\"content/publish\"]: async () => import(\"../../content/publish-schedule.ts\")")
      expect(contents).toContain("[\"report\"]: async () => import(")
    }
  })

  it("installs contributed Schedules through the Nuxt module", async () => {
    const { definition, root } = await createRoot({ file: false })
    const { default: scheduleNuxt } = await import("../src/nuxt.ts")
    let nitroConfigHook: ((nitroConfig: Record<string, unknown>) => void | Promise<void>) | undefined
    const nuxt = {
      hook(...[name, handler]:
        | ["nitro:config", (nitroConfig: Record<string, unknown>) => void | Promise<void>]
        | ["prepare:types", (context: { references: { path: string }[] }) => void]
      ) {
        if (name === "nitro:config") nitroConfigHook = handler
      },
      options: { dev: false, rootDir: root, srcDir: root, vite: { plugins: [publishContributor(definition)] as unknown[] } },
    }

    scheduleNuxt({}, nuxt)
    const nitroConfig: Record<string, unknown> = {}
    await nitroConfigHook?.(nitroConfig)

    expect(nitroConfig).toMatchObject({
      cloudflare: { wrangler: { triggers: { crons: ["*/5 * * * *"] } } },
      plugins: [join(root, ".vitehub/nitro/schedule/plugin.ts")],
    })
  })

  it("serves contributed Schedules from the registry that `vitehub schedule run` loads, with targets and types", async () => {
    const { definition, root } = await createRoot({
      definition: [
        "import { defineSchedule } from '@vite-hub/schedule'",
        "export default defineSchedule({ cron: '*/5 * * * *', allowRuntimeSchedules: true, handler: () => {} })",
        "",
      ].join("\n"),
    })
    const plugins = [publishContributor(definition)]
    const plugin = hubSchedule({ providerOutput: false })
    await (plugin.config as ConfigHook)({ plugins, root }, { command: "serve", mode: "development" })
    await resolvePlugin(plugin, root, plugins)

    const load = plugin.load as (id: string) => string
    expect(load("\0#vitehub/schedule/registry")).toContain(`["content/publish"]: async () => import(${JSON.stringify(definition)})`)
    expect(load("\0#vitehub/schedule/targets")).toContain("\"content/publish\"")
    await expect(readFile(join(root, ".vitehub", "schedule.d.ts"), "utf8")).resolves.toContain("\"content/publish\": typeof import(\"./content/publish-schedule.ts\").default")
  })

  it("invalidates the registry when a contributed Definition module changes", async () => {
    const { definition, root } = await createRoot()
    const plugins = [publishContributor(definition)]
    const plugin = hubSchedule({ providerOutput: false })
    await (plugin.config as ConfigHook)({ plugins, root }, { command: "serve", mode: "development" })
    await resolvePlugin(plugin, root, plugins)
    const registry = {}
    const invalidateModule = vi.fn()

    await (plugin.handleHotUpdate as (context: Record<string, unknown>) => Promise<unknown>)({
      file: definition,
      server: { config: { root }, moduleGraph: { getModuleById: () => registry, invalidateModule } },
    })

    expect(invalidateModule).toHaveBeenCalledWith(registry)
  })
})

describe("contributed Schedule inspection", () => {
  it("shows the contributing plugin and its reason", async () => {
    const { definition, root } = await createRoot()
    const plugins = [publishContributor(definition)]

    const listed = await inspectScheduleDefinitions({ plugins, projectRoot: root, rootDir: root, serverRootDir: root })

    expect(listed).toEqual([
      {
        fields: [
          { label: "Kind", value: "Static schedule" },
          { label: "Cron", value: "*/5 * * * *" },
          { label: "Time zone", value: "UTC" },
          { label: "Manual", value: "Enabled" },
          { label: "Contributed by", value: contentPlugin },
          { label: "Reason", value: reason },
        ],
        file: ".vitehub/content/publish-schedule.ts",
        name: "content/publish",
        source: "vite-plugin-contribution",
      },
      expect.objectContaining({ name: "report", source: "server-schedules" }),
    ])

    const plugin = hubSchedule()
    await resolvePlugin(plugin, root, plugins)
    const inspector = (plugin.vitehub!.inspect as () => { definitions: Array<{ list: () => Promise<unknown> }> })().definitions[0]!
    await expect(inspector.list()).resolves.toEqual(listed)
  })
})
