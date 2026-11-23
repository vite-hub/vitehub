import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres"
import { drizzle as drizzleProxy } from "drizzle-orm/pg-proxy"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

import { defineDatabase } from "../../database/src/definition.ts"
import { createNodePostgresDatabase } from "../../database/src/runtime/node-postgres.ts"
import { createDevPostgresDatabase } from "../../database/src/runtime/pglite.ts"
import { postgresAgentInvocationTables } from "../src/invocations/postgres.ts"

import type { AgentInvocationStoreCreateInput } from "../src/invocations.ts"

const useDatabase = vi.fn()
vi.mock("@vite-hub/database", () => ({ useDatabase }))

const url = process.env.VITEHUB_TEST_POSTGRES_URL

const timestamp = "2026-01-01T00:00:00.000Z"
const invocation = (id: string): AgentInvocationStoreCreateInput => ({
  agentName: "reviewer",
  createdAt: timestamp,
  id,
  observations: [],
  status: "running",
  traceId: `trace:${id}`,
  updatedAt: timestamp,
})
const observation = { attributes: { "vitehub.observation.id": "event:1" }, name: "agent.tool.call", timestamp, type: "run" as const }

async function journalMigration(tablePrefix: string): Promise<string[]> {
  return await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ ...postgresAgentInvocationTables({ tablePrefix }) }))
}

async function shareInvocationBetweenTwoProcesses(databases: { a: object, b: object }, tablePrefix: string) {
  useDatabase.mockImplementation((name: "a" | "b") => ({ db: databases[name] }))
  const { createDatabaseAgentInvocationStore } = await import("../src/invocations/database.ts")
  const journal = (database: "a" | "b") => createDatabaseAgentInvocationStore({ database, maxAge: false, maxRecords: false, tablePrefix })
  const [a, b] = [journal("a"), journal("b")]

  const created = await a.create(invocation("shared"))
  expect(created).toMatchObject({ created: true, record: { id: "shared", status: "running" } })
  await expect(a.claim("shared", "owner-a", 30_000)).resolves.toBe(true)
  await expect(b.claim("shared", "owner-b", 30_000)).resolves.toBe(false)
  await expect(b.get("shared")).resolves.toMatchObject({ cursor: created.record.cursor, status: "running" })
  await b.update("shared", { appendObservation: observation, timestamp })
  await expect(b.update("shared", { status: "cancelled", timestamp }, "owner-a")).resolves.toMatchObject({ status: "cancelled" })
  await expect(a.get("shared")).resolves.toMatchObject({ observations: [{ name: "agent.tool.call" }], status: "cancelled" })
  await expect(a.list({ status: "cancelled" })).resolves.toMatchObject({ invocations: [{ id: "shared" }] })
}

describe("Database Agent Invocation store on Postgres drivers", () => {
  const prefix = `drv_${process.pid}_`
  beforeEach(() => {
    vi.resetModules()
    useDatabase.mockReset()
  })

  it("stores Invocations on a PGlite Database", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "vitehub-agent-pglite-"))
    try {
      const definition = defineDatabase({ dialect: "postgresql", driver: "pglite", schema: {} })
      const db = await createDevPostgresDatabase(definition, { binding: "DB" }, { dataDir, migrationsDir: join(dataDir, "migrations") })
      const client: { exec: (sql: string) => Promise<unknown>, close: () => Promise<void> } = Reflect.get(db, "$client")
      for (const statement of await journalMigration(prefix)) await client.exec(statement)
      try {
        await shareInvocationBetweenTwoProcesses({ a: db, b: db }, prefix)
      }
      finally {
        await client.close()
      }
    }
    finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  it("fails with a code on a Postgres Database whose driver the journal cannot use", async () => {
    useDatabase.mockReturnValue({ db: drizzleProxy(async () => ({ rows: [] })) })
    const { createDatabaseAgentInvocationStore } = await import("../src/invocations/database.ts")
    const journal = createDatabaseAgentInvocationStore({ database: "proxy", maxAge: false, maxRecords: false })

    await expect(journal.create(invocation("proxy"))).rejects.toMatchObject({
      code: "AGENT_INVOCATIONS_POSTGRES_DRIVER_UNSUPPORTED",
      why: expect.stringContaining("\"proxy\""),
    })
  })

  describe.skipIf(!url)("on a Postgres server", () => {
    const pools: Array<{ end: () => Promise<void> }> = []
    const nodePostgres = () => {
      vi.stubEnv("VITEHUB_TEST_AGENT_DATABASE_URL", url!)
      const definition = defineDatabase({ connection: { url: { kind: "env-variable", source: { kind: "env", name: "VITEHUB_TEST_AGENT_DATABASE_URL" } } }, dialect: "postgresql", driver: "node-postgres", schema: {} })
      const db = createNodePostgresDatabase(definition, { binding: "DB" })
      pools.push(Reflect.get(db, "$client"))
      return db
    }
    afterAll(async () => {
      await nodePostgres().execute(`DROP TABLE IF EXISTS ${prefix}invocations_observations, ${prefix}invocations`)
      await Promise.all(pools.map(pool => pool.end()))
    })

    it("stores Invocations on a node-postgres Database that two processes share", async () => {
      const [a, b] = [nodePostgres(), nodePostgres()]
      for (const statement of await journalMigration(prefix)) await a.execute(statement)
      await shareInvocationBetweenTwoProcesses({ a, b }, prefix)
    })
  })
})
