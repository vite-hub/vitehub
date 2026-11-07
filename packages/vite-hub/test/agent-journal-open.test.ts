import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createDefaultAgentInvocations } from "@vite-hub/agent/invocations/default"

import { installAgentInvocations } from "../src/_internal/agent/invocations.ts"
import { getAgentInvocationsDatabase } from "../src/agent/invocations/journal.ts"
import { getConsoleUsageIndex } from "../src/console/runtime/server/invocations.ts"

const opens = vi.hoisted(() => ({ count: 0 }))

vi.mock("@libsql/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@libsql/client")>()
  return {
    ...original,
    createClient(...input: Parameters<typeof original.createClient>) {
      opens.count++
      return original.createClient(...input)
    },
  }
})

let directory: string

beforeEach(async () => {
  vi.stubEnv("VITEHUB_AGENT_INVOCATIONS_DATABASE_URL", "")
  opens.count = 0
  directory = await mkdtemp(join(tmpdir(), "vitehub-agent-journal-open-"))
})

afterEach(async () => {
  installAgentInvocations({})
  vi.unstubAllEnvs()
  await rm(directory, { force: true, recursive: true })
})

describe("Default Agent journal open", () => {
  it("opens the libSQL journal on first use, once for concurrent first uses", async () => {
    const file = join(directory, ".vitehub/data/agent-invocations.sqlite")
    const invocations = createDefaultAgentInvocations({ projectRoot: directory })
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
    installAgentInvocations({ default: { databaseUrl: "file:journal.sqlite" }, journal: { projectRoot: directory } })
    expect(opens.count).toBe(0)
    const [database, other] = await Promise.all([getAgentInvocationsDatabase(), getAgentInvocationsDatabase()])
    expect(other).toBe(database)
    if (database?.driver !== "libsql") throw new TypeError("Expected the libSQL journal.")
    await expect(database.db.select().from(database.schema.invocations)).resolves.toEqual([])
    expect(opens.count).toBe(1)
    expect(existsSync(join(directory, "journal.sqlite"))).toBe(true)
  })

  it("opens again after a failed open", async () => {
    const invocations = createDefaultAgentInvocations({ databaseUrl: "file:journal.sqlite", projectRoot: directory, retention: { maxRecords: 0 } })
    await expect(invocations.list()).rejects.toThrow("SQLite Agent Invocation maxRecords must be a positive")
    await expect(invocations.list()).rejects.toThrow("SQLite Agent Invocation maxRecords must be a positive")
    expect(opens.count).toBe(2)
  })
})
