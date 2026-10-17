import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-catalog"
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
    }])).toContain('["welcome"]: async () => import(')
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

  it("reads manual opt-in from object-shaped defineSchedule calls", async () => {
    const rootDir = await createTempDir("vitehub-schedule-manual-opt-in-")
    await writeFile(
      join(rootDir, "daily.schedule.ts"),
      "export default defineSchedule({ cron: '0 9 * * *', handler: () => {}, manual: true /* manual runs */ })\n",
      "utf8",
    )
    await writeFile(
      join(rootDir, "weekly.schedule.ts"),
      "export default defineSchedule({ cron: '0 9 * * 1', handler: () => {}, manual: true // manual runs\n})\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir,
    }).map(definition => [definition.name, definition.manual])).toEqual([
      ["daily", true],
      ["weekly", true],
    ])
  })

  it("reads literal metadata beside a URL in the handler", async () => {
    const rootDir = await createTempDir("vitehub-schedule-handler-url-")
    await writeFile(
      join(rootDir, "daily.schedule.ts"),
      "export default defineSchedule({ cron: '0 9 * * *', handler: () => fetch('https://example.com'), manual: true })\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({ rootDir })).toMatchObject([{
      manual: true,
      name: "daily",
      source: "vite-suffix",
    }])
  })

  it("reads manual opt-in from generic defineSchedule calls", async () => {
    const rootDir = await createTempDir("vitehub-schedule-manual-generic-opt-in-")
    await writeFile(
      join(rootDir, "daily.schedule.ts"),
      "export default defineSchedule<string>({ cron: '0 9 * * *', handler: () => 'ok', manual: true })\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir,
    }).map(definition => [definition.name, definition.manual])).toEqual([
      ["daily", true],
    ])
  })

  it("reads manual opt-in from defineSchedule generics with arrow function types", async () => {
    const rootDir = await createTempDir("vitehub-schedule-manual-arrow-generic-opt-in-")
    await writeFile(
      join(rootDir, "daily.schedule.ts"),
      "export default defineSchedule<{ f: (x: string) => string }>({ cron: '0 9 * * *', handler: () => 'ok', manual: true })\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir,
    }).map(definition => [definition.name, definition.manual])).toEqual([
      ["daily", true],
    ])
  })

  it("reads manual opt-in from parenthesized defineSchedule calls", async () => {
    const rootDir = await createTempDir("vitehub-schedule-manual-parenthesized-opt-in-")
    await writeFile(
      join(rootDir, "daily.schedule.ts"),
      "export default ((defineSchedule({ cron: '0 9 * * *', handler: () => 'ok', manual: true })))\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir,
    }).map(definition => [definition.name, definition.manual])).toEqual([
      ["daily", true],
    ])
  })

  it("balances regex literals while reading manual opt-in", async () => {
    const rootDir = await createTempDir("vitehub-schedule-manual-regex-opt-in-")
    await writeFile(
      join(rootDir, "daily.schedule.ts"),
      [
        "export default defineSchedule({",
        "  cron: '0 9 * * *',",
        "  handler: () => /}/.test('x'),",
        "  manual: true,",
        "})",
      ].join("\n"),
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir,
    }).map(definition => [definition.name, definition.manual])).toEqual([
      ["daily", true],
    ])
  })

  it("ignores commented and quoted manual opt-in examples", async () => {
    const rootDir = await createTempDir("vitehub-schedule-manual-non-code-opt-in-")
    await writeFile(
      join(rootDir, "daily.schedule.ts"),
      [
        "// export default defineSchedule({ cron: '0 8 * * *', handler: () => {}, manual: true })",
        "const docs = \"export default defineSchedule({ cron: '0 8 * * *', handler: () => {}, manual: true })\"",
        "export default defineSchedule({ cron: '0 9 * * *', handler: () => {}, manual: false })",
      ].join("\n"),
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir,
    }).map(definition => [definition.name, definition.manual])).toEqual([
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
