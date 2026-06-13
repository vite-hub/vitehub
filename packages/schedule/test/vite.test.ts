import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { createDefaultCloudflareOutputRoot } from "@vite-hub/internal/build/deployment-output"
import { hubSchedule } from "../src/vite.ts"

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
    await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      userConfig,
      { command: "build", mode: "production" },
    )

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
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.ts"), "utf8")).resolves.toContain("build:before")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.ts"), "utf8")).resolves.toContain("dedupeCloudflareCrons")
    await expect(readFile(join(root, ".vitehub", "nitro", "schedule", "module.ts"), "utf8")).resolves.toContain("\"*/10 * * * *\"")
    await expect(readFile(join(root, ".vitehub", "schedule", "registry.js"), "utf8")).resolves.toContain("\"mirror\": async () => import(")
    await expect(readFile(join(root, ".vitehub", "schedule", "registry.d.ts"), "utf8")).resolves.toContain("ScheduleDefinition")
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
    await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      userConfig,
      { command: "build", mode: "production" },
    )
    resolvePluginConfig(plugin, appRoot)
    const registry = await loadScheduleRegistry(plugin)

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

    expect(config).toBeNull()
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
    await (plugin.config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => unknown)(
      userConfig,
      { command: "build", mode: "production" },
    )

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
  })

  it("serves a stable lazy registry for discovered schedule files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-vite-"))
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "cleanup.schedule.ts"), "export default null\n", "utf8")
    await writeFile(join(root, "src", "reports.schedule.ts"), "export default defineSchedule({ cron: \"0 0 * * *\", handler: () => {} })\n", "utf8")

    const plugin = hubSchedule()
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
