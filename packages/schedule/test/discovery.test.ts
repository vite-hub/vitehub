import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
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

  it("discovers schedule ids for Vite and Nitro entrypoints", async () => {
    const viteRootDir = await createTempDir("vitehub-schedule-vite-discovery-")
    await mkdir(join(viteRootDir, "src", "emails"), { recursive: true })
    await writeFile(join(viteRootDir, "src", "emails", "digest.schedule.ts"), "export default null\n", "utf8")
    await writeFile(join(viteRootDir, "src", "billing.schedule.ts"), "export default null\n", "utf8")

    const nitroScanDir = await createTempDir("vitehub-schedule-nitro-discovery-")
    await mkdir(join(nitroScanDir, "schedules", "emails"), { recursive: true })
    await mkdir(join(nitroScanDir, "schedules", "billing"), { recursive: true })
    await writeFile(join(nitroScanDir, "schedules", "emails", "digest.ts"), "export default null\n", "utf8")
    await writeFile(join(nitroScanDir, "schedules", "billing", "index.ts"), "export default null\n", "utf8")
    await writeFile(join(nitroScanDir, "schedules", "welcome.d.ts"), "export type Welcome = string\n", "utf8")

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    }).map(definition => definition.name)).toEqual([
      "billing",
      "emails/digest",
    ])

    expect(discoverScheduleDefinitions({
      mode: "nitro-server-schedules",
      scanDirs: [nitroScanDir],
    }).map(definition => definition.name)).toEqual([
      "billing",
      "emails/digest",
    ])
  })

  it("uses explicit ids from defineSchedule options", async () => {
    const viteRootDir = await createTempDir("vitehub-schedule-explicit-id-")
    await writeFile(join(viteRootDir, "daily.schedule.ts"), "export default defineSchedule('0 9 * * *', () => {}, { id: 'reports/daily' })\n", "utf8")

    const nitroScanDir = await createTempDir("vitehub-schedule-nitro-explicit-id-")
    await mkdir(join(nitroScanDir, "schedules"), { recursive: true })
    await writeFile(join(nitroScanDir, "schedules", "daily.ts"), "export default defineSchedule('0 9 * * *', () => {}, { id: 'reports/daily' })\n", "utf8")

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    }).map(definition => definition.name)).toEqual(["reports/daily"])

    expect(discoverScheduleDefinitions({
      mode: "nitro-server-schedules",
      scanDirs: [nitroScanDir],
    }).map(definition => definition.name)).toEqual(["reports/daily"])
  })

  it("uses explicit ids from quoted defineSchedule option keys", async () => {
    const viteRootDir = await createTempDir("vitehub-schedule-quoted-explicit-id-")
    await writeFile(join(viteRootDir, "daily.schedule.ts"), "export default defineSchedule('0 9 * * *', () => {}, { 'id': 'reports/daily' })\n", "utf8")
    await writeFile(join(viteRootDir, "weekly.schedule.ts"), "export default defineSchedule('0 9 * * 1', () => {}, { \"id\": \"reports/weekly\" })\n", "utf8")

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    }).map(definition => definition.name)).toEqual(["reports/daily", "reports/weekly"])
  })

  it("ignores nested id fields when no defineSchedule id option is set", async () => {
    const viteRootDir = await createTempDir("vitehub-schedule-nested-id-")
    await writeFile(
      join(viteRootDir, "daily.schedule.ts"),
      "export default defineSchedule('0 9 * * *', () => foo(1, { id: 'inner' }))\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    }).map(definition => definition.name)).toEqual(["daily"])
  })

  it("reads ids from nested generic defineSchedule calls", async () => {
    const viteRootDir = await createTempDir("vitehub-schedule-nested-generic-")
    await writeFile(
      join(viteRootDir, "daily.schedule.ts"),
      "export default defineSchedule<Promise<string>>('0 9 * * *', async () => 'ok', { id: 'reports/daily' })\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    }).map(definition => definition.name)).toEqual(["reports/daily"])
  })

  it("ignores commented defineSchedule examples during id discovery", async () => {
    const viteRootDir = await createTempDir("vitehub-schedule-commented-")
    await writeFile(
      join(viteRootDir, "daily.schedule.ts"),
      "// defineSchedule('0 9 * * *', () => {}, { id: 'docs/example' })\nexport default defineSchedule('0 9 * * *', () => {}, { id: 'reports/daily' })\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    }).map(definition => definition.name)).toEqual(["reports/daily"])
  })

  it("preserves string literals while ignoring comments during id discovery", async () => {
    const viteRootDir = await createTempDir("vitehub-schedule-comment-string-")
    await writeFile(
      join(viteRootDir, "daily.schedule.ts"),
      "export default defineSchedule('0 9 * * *', () => { const path = 'foo//bar' }, { id: 'reports/daily' })\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    }).map(definition => definition.name)).toEqual(["reports/daily"])
  })

  it("preserves regex literals while reading defineSchedule options", async () => {
    const viteRootDir = await createTempDir("vitehub-schedule-regex-literal-")
    await writeFile(
      join(viteRootDir, "daily.schedule.ts"),
      "export default defineSchedule('0 9 * * *', () => /\\)/.test(')'), { id: 'reports/daily' })\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    }).map(definition => definition.name)).toEqual(["reports/daily"])
  })

  it("ignores nested id fields in defineSchedule options", async () => {
    const viteRootDir = await createTempDir("vitehub-schedule-nested-options-id-")
    await writeFile(
      join(viteRootDir, "daily.schedule.ts"),
      "export default defineSchedule('0 9 * * *', () => {}, { retry: { id: 'nested' } })\n",
      "utf8",
    )

    expect(discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    }).map(definition => definition.name)).toEqual(["daily"])
  })

  it("rejects duplicate schedule ids across discovery roots and explicit ids", async () => {
    const viteRootDir = await createTempDir("vitehub-schedule-vite-duplicate-")
    const viteScanDir = await createTempDir("vitehub-schedule-vite-duplicate-scan-")
    await writeFile(join(viteRootDir, "welcome.schedule.ts"), "export default null\n", "utf8")
    await writeFile(join(viteScanDir, "daily.schedule.ts"), "export default defineSchedule('0 9 * * *', () => {}, { id: 'welcome' })\n", "utf8")

    expect(() => discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
      scanDirs: [viteScanDir],
    })).toThrow(/Duplicate schedule name/)

    const firstNitroScanDir = await createTempDir("vitehub-schedule-nitro-first-")
    const secondNitroScanDir = await createTempDir("vitehub-schedule-nitro-second-")
    await mkdir(join(firstNitroScanDir, "schedules"), { recursive: true })
    await mkdir(join(secondNitroScanDir, "schedules"), { recursive: true })
    await writeFile(join(firstNitroScanDir, "schedules", "welcome.ts"), "export default null\n", "utf8")
    await writeFile(join(secondNitroScanDir, "schedules", "daily.ts"), "export default defineSchedule('0 9 * * *', () => {}, { id: 'welcome' })\n", "utf8")

    expect(() => discoverScheduleDefinitions({
      mode: "nitro-server-schedules",
      scanDirs: [firstNitroScanDir, secondNitroScanDir],
    })).toThrow(/Duplicate schedule name/)
  })
})
