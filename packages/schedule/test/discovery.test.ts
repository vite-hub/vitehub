import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-discovery"
import { discoverScheduleDefinitions } from "../src/discovery.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function createTempDir(prefix: string) {
  const rootDir = await mkdtemp(join(tmpdir(), prefix))
  directories.push(rootDir)
  return rootDir
}

describe("discoverScheduleDefinitions", () => {
  it("creates a runtime registry file", async () => {
    const rootDir = await createTempDir("vitehub-schedule-registry-")
    const registryFile = join(rootDir, ".vitehub", "schedule", "registry.mjs")
    const sourceFile = join(rootDir, "welcome.schedule.ts")
    await writeFile(sourceFile, "export default null\n", "utf8")

    expect(createRuntimeRegistryContents(registryFile, [{
      handler: sourceFile,
      name: "welcome",
    }])).toContain('"welcome": async () => import(')
  })

  it("derives Vite schedule identity from the schedule file location", async () => {
    const rootDir = await createTempDir("vitehub-schedule-vite-discovery-")
    await mkdir(join(rootDir, "src", "emails"), { recursive: true })
    await writeFile(join(rootDir, "src", "emails", "digest.schedule.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "src", "billing.schedule.ts"), "export default null\n", "utf8")

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir,
    }).map(definition => definition.name)).toEqual([
      "billing",
      "emails/digest",
    ])
  })

  it("derives server schedule identity from the server schedules location", async () => {
    const scanDir = await createTempDir("vitehub-schedule-server-discovery-")
    await mkdir(join(scanDir, "schedules", "emails"), { recursive: true })
    await mkdir(join(scanDir, "schedules", "billing"), { recursive: true })
    await writeFile(join(scanDir, "schedules", "emails", "digest.ts"), "export default null\n", "utf8")
    await writeFile(join(scanDir, "schedules", "billing", "index.ts"), "export default null\n", "utf8")
    await writeFile(join(scanDir, "schedules", "welcome.d.ts"), "export type Welcome = string\n", "utf8")

    expect(discoverScheduleDefinitions({
      mode: "server-schedules",
      scanDirs: [scanDir],
    }).map(definition => definition.name)).toEqual([
      "billing",
      "emails/digest",
    ])
  })

  it("discovers server schedules through Vite discovery", async () => {
    const rootDir = await createTempDir("vitehub-schedule-vite-server-discovery-")
    await mkdir(join(rootDir, "server", "schedules", "emails"), { recursive: true })
    await mkdir(join(rootDir, "server", "schedules", "billing"), { recursive: true })
    await writeFile(join(rootDir, "server", "schedules", "emails", "digest.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "server", "schedules", "billing", "index.ts"), "export default null\n", "utf8")

    expect(discoverScheduleDefinitions({ rootDir })).toMatchObject([
      { name: "billing", source: "server-schedules" },
      { name: "emails/digest", source: "server-schedules" },
    ])
  })

  it("discovers suffix schedules in a sibling Nuxt server directory", async () => {
    const rootDir = await createTempDir("vitehub-schedule-nuxt-server-discovery-")
    const appDir = join(rootDir, "app")
    const serverDir = join(rootDir, "server")
    await mkdir(join(serverDir, "schedules"), { recursive: true })
    await writeFile(join(serverDir, "monthly.schedule.ts"), "export default null\n", "utf8")
    await writeFile(join(serverDir, "schedules", "daily.schedule.ts"), "export default null\n", "utf8")

    expect(discoverScheduleDefinitions({
      rootDir: appDir,
      serverDirs: [serverDir],
      serverRootDir: rootDir,
    })).toMatchObject([
      { name: "daily.schedule", source: "server-schedules" },
      { name: "monthly", source: "vite-suffix" },
    ])
  })

  it("does not parse defineSchedule options to override discovery identity", async () => {
    const rootDir = await createTempDir("vitehub-schedule-ignore-inline-id-")
    await writeFile(
      join(rootDir, "daily.schedule.ts"),
      "export default defineSchedule({ cron: '0 9 * * *', handler: () => {}, id: 'reports/daily' } as never)\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir,
    }).map(definition => definition.name)).toEqual(["daily"])
  })

  it("reads runtime opt-in from object-shaped defineSchedule calls", async () => {
    const rootDir = await createTempDir("vitehub-schedule-runtime-opt-in-")
    await writeFile(
      join(rootDir, "daily.schedule.ts"),
      "export default defineSchedule({ cron: '0 9 * * *', handler: () => {}, allowRuntimeSchedules: true /* runtime target */ })\n",
      "utf8",
    )
    await writeFile(
      join(rootDir, "weekly.schedule.ts"),
      "export default defineSchedule({ cron: '0 9 * * 1', handler: () => {}, allowRuntimeSchedules: true // runtime target\n})\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir,
    }).map(definition => [definition.name, definition.allowRuntimeSchedules])).toEqual([
      ["daily", true],
      ["weekly", true],
    ])
  })

  it("discovers defineScheduleTarget calls as runtime-only targets", async () => {
    const rootDir = await createTempDir("vitehub-schedule-runtime-target-")
    await writeFile(
      join(rootDir, "agent-turn.schedule.ts"),
      "export default defineScheduleTarget<{ prompt: string }>({ handler: context => context.input?.prompt })\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir,
    })).toMatchObject([{
      allowRuntimeSchedules: true,
      name: "agent-turn",
      runtimeOnly: true,
      source: "vite-suffix",
    }])
  })

  it("reads runtime opt-in from generic defineSchedule calls", async () => {
    const rootDir = await createTempDir("vitehub-schedule-runtime-generic-opt-in-")
    await writeFile(
      join(rootDir, "daily.schedule.ts"),
      "export default defineSchedule<string>({ cron: '0 9 * * *', handler: () => 'ok', allowRuntimeSchedules: true })\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir,
    }).map(definition => [definition.name, definition.allowRuntimeSchedules])).toEqual([
      ["daily", true],
    ])
  })

  it("reads runtime opt-in from defineSchedule generics with arrow function types", async () => {
    const rootDir = await createTempDir("vitehub-schedule-runtime-arrow-generic-opt-in-")
    await writeFile(
      join(rootDir, "daily.schedule.ts"),
      "export default defineSchedule<{ f: (x: string) => string }>({ cron: '0 9 * * *', handler: () => 'ok', allowRuntimeSchedules: true })\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir,
    }).map(definition => [definition.name, definition.allowRuntimeSchedules])).toEqual([
      ["daily", true],
    ])
  })

  it("reads runtime opt-in from parenthesized defineSchedule calls", async () => {
    const rootDir = await createTempDir("vitehub-schedule-runtime-parenthesized-opt-in-")
    await writeFile(
      join(rootDir, "daily.schedule.ts"),
      "export default ((defineSchedule({ cron: '0 9 * * *', handler: () => 'ok', allowRuntimeSchedules: true })))\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir,
    }).map(definition => [definition.name, definition.allowRuntimeSchedules])).toEqual([
      ["daily", true],
    ])
  })

  it("balances regex literals while reading runtime opt-in", async () => {
    const rootDir = await createTempDir("vitehub-schedule-runtime-regex-opt-in-")
    await writeFile(
      join(rootDir, "daily.schedule.ts"),
      [
        "export default defineSchedule({",
        "  cron: '0 9 * * *',",
        "  handler: () => /}/.test('x'),",
        "  allowRuntimeSchedules: true,",
        "})",
      ].join("\n"),
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir,
    }).map(definition => [definition.name, definition.allowRuntimeSchedules])).toEqual([
      ["daily", true],
    ])
  })

  it("ignores commented and quoted runtime opt-in examples", async () => {
    const rootDir = await createTempDir("vitehub-schedule-runtime-non-code-opt-in-")
    await writeFile(
      join(rootDir, "daily.schedule.ts"),
      [
        "// export default defineSchedule({ cron: '0 8 * * *', handler: () => {}, allowRuntimeSchedules: true })",
        "const docs = \"export default defineSchedule({ cron: '0 8 * * *', handler: () => {}, allowRuntimeSchedules: true })\"",
        "export default defineSchedule({ cron: '0 9 * * *', handler: () => {}, allowRuntimeSchedules: false })",
      ].join("\n"),
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir,
    }).map(definition => [definition.name, definition.allowRuntimeSchedules])).toEqual([
      ["daily", false],
    ])
  })

  it("reports duplicate discovery identities from location", async () => {
    const rootDir = await createTempDir("vitehub-schedule-duplicates-")
    const scanDir = await createTempDir("vitehub-schedule-duplicates-scan-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(scanDir, { recursive: true })
    await writeFile(join(rootDir, "src", "daily.schedule.ts"), "export default null\n", "utf8")
    await writeFile(join(scanDir, "daily.schedule.ts"), "export default null\n", "utf8")

    expect(() => discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir,
      scanDirs: [join(rootDir, "src"), scanDir],
    })).toThrow(/Duplicate schedule name "daily"/)
  })
})
