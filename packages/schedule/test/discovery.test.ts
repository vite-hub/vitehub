import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createRuntimeRegistryContents } from "@vitehub/internal/definition-discovery"
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

  it("derives Nitro schedule identity from the server schedules location", async () => {
    const scanDir = await createTempDir("vitehub-schedule-nitro-discovery-")
    await mkdir(join(scanDir, "schedules", "emails"), { recursive: true })
    await mkdir(join(scanDir, "schedules", "billing"), { recursive: true })
    await writeFile(join(scanDir, "schedules", "emails", "digest.ts"), "export default null\n", "utf8")
    await writeFile(join(scanDir, "schedules", "billing", "index.ts"), "export default null\n", "utf8")
    await writeFile(join(scanDir, "schedules", "welcome.d.ts"), "export type Welcome = string\n", "utf8")

    expect(discoverScheduleDefinitions({
      mode: "nitro-server-schedules",
      scanDirs: [scanDir],
    }).map(definition => definition.name)).toEqual([
      "billing",
      "emails/digest",
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
