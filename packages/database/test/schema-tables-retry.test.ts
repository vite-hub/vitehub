import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { loadDatabaseTableNames } from "../src/internal/schema-tables.ts"

// Drizzle fails to load once, as an import can fail when a dependency is reinstalled during development.
const drizzle = vi.hoisted(() => ({ failures: 1 }))

vi.mock("drizzle-orm/sqlite-core", async (importOriginal) => {
  if (drizzle.failures > 0) {
    drizzle.failures--
    throw new Error("transient Drizzle import failure")
  }
  return await importOriginal()
})

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("Database schema loading", () => {
  it("loads Drizzle again after a failed load", async () => {
    const rootDir = await mkdtemp(join(import.meta.dirname, ".schema-tables-retry-"))
    tempDirs.push(rootDir)
    const handler = join(rootDir, "config.ts")
    await writeFile(handler, "export default { schema: {} }\n")

    await expect(loadDatabaseTableNames(handler)).rejects.toThrow("could not load")
    await expect(loadDatabaseTableNames(handler)).resolves.toEqual([])
  })
})
