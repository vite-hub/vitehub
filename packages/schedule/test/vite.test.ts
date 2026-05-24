import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { createScheduleRegistryContents } from "../src/registry-module.ts"
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
  it("serves a stable lazy registry for discovered schedule files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-vite-"))
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "cleanup.schedule.ts"), "export default null\n", "utf8")
    await writeFile(join(root, "src", "reports.schedule.ts"), "defineSchedule(\"0 0 * * *\", () => {}, { id: \"daily-reports\" })\n", "utf8")

    const plugin = hubSchedule()
    resolvePluginConfig(plugin, root)
    const registry = await loadScheduleRegistry(plugin)

    expect(resolveScheduleRegistry(plugin)).toBe("\0#vitehub/schedule/registry")
    expect(registry).toContain("\"cleanup\": async () => import(")
    expect(registry).toContain("\"daily-reports\": async () => import(")
  })

  it("serves generated runtime schedule target names behind a stable import", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-targets-"))
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "cleanup.schedule.ts"), "defineSchedule(\"0 0 * * *\", () => {})\n", "utf8")
    await writeFile(join(root, "src", "reports.schedule.ts"), "defineSchedule(\"0 0 * * *\", () => {}, { id: \"daily-reports\", allowRuntimeSchedules: true })\n", "utf8")

    const plugin = hubSchedule()
    resolvePluginConfig(plugin, root)
    const targets = await loadScheduleTargets(plugin)

    expect(resolveScheduleTargets(plugin)).toBe("\0#vitehub/schedule/targets")
    expect(targets).toContain("export const scheduleTargetNames = [\"daily-reports\"];")
    expect(targets).toContain("export type ScheduleTargetName = \"daily-reports\";")
    expect(targets).not.toContain("\"cleanup\"")
  })

  it("lowers inline Agent Schedules into generated schedule definitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-schedule-registry-"))
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "support.agent.ts"), [
      "import { defineAgent, schedule } from '@vitehub/agent'",
      "export default defineAgent({",
      "  capabilities: [schedule({ schedules: [{ cron: '0 9 * * *', id: 'daily' }] })],",
      "  run: () => 'ok',",
      "})",
    ].join("\n"), "utf8")

    const plugin = hubSchedule()
    resolvePluginConfig(plugin, root)
    const registry = await loadScheduleRegistry(plugin)

    expect(registry).toContain("import { runScheduledAgent } from \"@vitehub/agent\"")
    expect(registry).toContain("\"support/daily\": async () => ({")
    expect(registry).toContain("cron: \"0 9 * * *\"")
    expect(registry).toContain("options: { id: \"support/daily\", target: \"support\" }")
    expect(registry).toContain("handler: async (context) => runScheduledAgent(")
  })

  it("normalizes generated registry import specifiers", () => {
    const registry = createScheduleRegistryContents("C:\\project\\.vitehub\\schedule\\registry.mjs", [{
      handler: "C:\\project\\src\\daily.schedule.ts",
      name: "daily",
    }])

    expect(registry).toContain("C:/project/src/daily.schedule.ts")
    expect(registry).not.toContain("\\\\")
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
