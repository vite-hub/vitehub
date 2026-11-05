import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createConsoleInvocations, getConsoleInvocationsDatabase, getConsoleUsageIndex, installConsoleInvocations } from "../src/console/runtime/server/invocations.ts"

const opens = vi.hoisted(() => ({ count: 0 }))

vi.mock("../src/console/runtime/server/invocations-database.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/console/runtime/server/invocations-database.ts")>()
  return {
    ...original,
    openConsoleLibsqlJournal(...input: Parameters<typeof original.openConsoleLibsqlJournal>) {
      opens.count++
      return original.openConsoleLibsqlJournal(...input)
    },
  }
})

let directory: string

beforeEach(async () => {
  vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", "")
  opens.count = 0
  directory = await mkdtemp(join(tmpdir(), "vitehub-console-journal-open-"))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(directory, { force: true, recursive: true })
})

describe("Console journal open", () => {
  it("opens the libSQL journal on first use, once for concurrent first uses", async () => {
    const file = join(directory, "console.sqlite")
    const invocations = createConsoleInvocations(directory, undefined, `file:${file}`)
    expect(opens.count).toBe(0)
    expect(existsSync(file)).toBe(false)

    await Promise.all([
      invocations.list(),
      invocations.getSummary("missing"),
      invocations.getByRunId("missing"),
    ])
    await getConsoleUsageIndex(invocations)!.query()
    expect(opens.count).toBe(1)
    expect(existsSync(file)).toBe(true)
  })

  it("shares the open journal with Drizzle", async () => {
    const invocations = installConsoleInvocations(directory, undefined, undefined, "file:console.sqlite")
    expect(opens.count).toBe(0)
    const [database, other] = await Promise.all([getConsoleInvocationsDatabase(), getConsoleInvocationsDatabase(), invocations.list()])
    expect(other).toBe(database)
    await expect(database.db.select().from(database.schema.invocations)).resolves.toEqual([])
    expect(opens.count).toBe(1)
  })

  it("opens again after a failed open", async () => {
    const invocations = createConsoleInvocations(directory, undefined, "file:console.sqlite", { maxRecords: 0 })
    await expect(invocations.list()).rejects.toThrow("SQLite Agent Invocation maxRecords must be a positive")
    await expect(invocations.list()).rejects.toThrow("SQLite Agent Invocation maxRecords must be a positive")
    expect(opens.count).toBe(2)
  })
})
