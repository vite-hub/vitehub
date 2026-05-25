import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { hubSchedule } from "../src/vite.ts"

function resolveScheduleRegistry(plugin: ReturnType<typeof hubSchedule>) {
  return (plugin.resolveId as (id: string, importer?: string, options?: unknown) => unknown)("#vitehub/schedule/registry")
}

async function loadScheduleRegistry(plugin: ReturnType<typeof hubSchedule>) {
  return await (plugin.load as (id: string, options?: unknown) => string | Promise<string>)("\0#vitehub/schedule/registry")
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
    expect(registry).toContain("../../src/cleanup.schedule.ts")
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
