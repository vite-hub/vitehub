import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { collectViteHubResourceSummaries } from "@vite-hub/internal/inspect"

import { hubSchedule } from "../src/vite.ts"

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function project() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-resources-"))
  roots.push(root)
  await mkdir(join(root, "server", "schedules"), { recursive: true })
  await writeFile(join(root, "server", "schedules", "cleanup.ts"), "export default defineSchedule({ cron: '0 3 * * *', handler: () => {} })\n", "utf8")
  await writeFile(join(root, "server", "schedules", "daily.ts"), "export default defineSchedule({ cron: '0 8 * * *', timeZone: 'Europe/Madrid', handler: () => {} })\n", "utf8")
  await writeFile(join(root, "server", "schedules", "reminder.ts"), "export default defineSchedule({ handler: () => {} })\n", "utf8")
  return root
}

async function resolvePlugin(root: string, preset: string, options?: Parameters<typeof hubSchedule>[0]) {
  const plugin = hubSchedule(options)
  const config: Record<string, unknown> = { command: "build", nitro: { preset }, root }
  await (plugin.config as (config: Record<string, unknown>, env: { command: "build", mode: string }) => Promise<void>)(config, { command: "build", mode: "production" })
  await (plugin.configResolved as (config: Record<string, unknown>) => Promise<void>)(config)
  return { config, plugin }
}

describe("hubSchedule resources", () => {
  it("lists one Cloudflare cron trigger per Schedule, with the crons the build writes", async () => {
    const { config, plugin } = await resolvePlugin(await project(), "cloudflare_module", { cron: { cleanup: "0 4 * * 1-5" } })

    const resources = await collectViteHubResourceSummaries([plugin])
    expect(resources).toEqual([
      expect.objectContaining({ definition: "cleanup", host: "cloudflare", kind: "cloudflare-cron", name: "0 4 * * MON,TUE,WED,THU,FRI", owner: "schedule" }),
      expect.objectContaining({ definition: "daily", host: "cloudflare", kind: "cloudflare-cron", name: "0 6,7 * * *", owner: "schedule" }),
      expect.objectContaining({ definition: "vitehub/started-schedules", host: "cloudflare", kind: "cloudflare-cron", name: "* * * * *", owner: "schedule" }),
    ])
    expect(resources.every(resource => resource.binding === undefined)).toBe(true)
    expect(config).toHaveProperty("nitro.cloudflare.wrangler.triggers.crons", [...new Set(resources.map(resource => resource.name))])
  })

  it("lists nothing on other hosts", async () => {
    const { plugin } = await resolvePlugin(await project(), "node-server")
    expect(await collectViteHubResourceSummaries([plugin])).toEqual([])
  })

  it("lists nothing when the Process Runtime runs the Schedules", async () => {
    const { plugin } = await resolvePlugin(await project(), "cloudflare_module", { runtime: { driver: "process" } })
    expect(await collectViteHubResourceSummaries([plugin])).toEqual([])
  })
})

describe("hubSchedule standalone resources", () => {
  async function suffixProject() {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-resources-suffix-"))
    roots.push(root)
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "cleanup.schedule.ts"), "export default defineSchedule({ cron: '0 3 * * *', handler: () => {} })\n", "utf8")
    return root
  }

  async function resolveWithoutNitro(root: string, options?: Parameters<typeof hubSchedule>[0]) {
    const plugin = hubSchedule(options)
    const config: Record<string, unknown> = { command: "build", root }
    await (plugin.config as (config: Record<string, unknown>, env: { command: "build", mode: string }) => Promise<void>)(config, { command: "build", mode: "production" })
    await (plugin.configResolved as (config: Record<string, unknown>) => Promise<void>)(config)
    return plugin
  }

  it.each([[undefined], [{ providerOutput: "standalone" as const }]])("lists the cron of the standalone Schedule Worker when no host is known, for %j", async (options) => {
    const plugin = await resolveWithoutNitro(await suffixProject(), options)
    expect(await collectViteHubResourceSummaries([plugin])).toEqual([
      expect.objectContaining({ definition: "cleanup", host: "cloudflare", kind: "cloudflare-cron", name: "0 3 * * *", standalone: true }),
    ])
  })

  it("lists the cron of a suffix Schedule in a Cloudflare build as standalone", async () => {
    const { plugin } = await resolvePlugin(await suffixProject(), "cloudflare_module")
    expect(await collectViteHubResourceSummaries([plugin])).toEqual([
      expect.objectContaining({ definition: "cleanup", kind: "cloudflare-cron", name: "0 3 * * *", standalone: true }),
    ])
  })
})
