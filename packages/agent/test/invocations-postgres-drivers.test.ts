import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres"
import { sql } from "drizzle-orm"
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

  it.each([false, true])("rolls back a timed-out BEGIN (rollback fails: %s)", async (rollbackFails) => {
    const failure = new Error("Query read timeout")
    const connection = Object.assign(new EventEmitter(), {
      query: vi.fn().mockRejectedValueOnce(failure).mockImplementationOnce(async () => {
        if (rollbackFails) throw new Error("Rollback timed out")
        return { rows: [] }
      }),
      release: vi.fn(),
    })
    const { agentInvocationPostgresClient } = await import("../src/invocations/postgres-clients.ts")
    const client = agentInvocationPostgresClient({ connect: async () => connection, query: vi.fn(), totalCount: 1 }, "DB")
    const run = vi.fn()

    await expect(client.begin(run)).rejects.toBe(failure)
    expect(run).not.toHaveBeenCalled()
    expect(connection.query.mock.calls).toEqual([["BEGIN"], ["ROLLBACK"]])
    expect(connection.release).toHaveBeenCalledExactlyOnceWith(rollbackFails)
    expect(connection.listenerCount("error")).toBe(0)
  })

  it("does not commit when a checked-out connection emits an error between queries", async () => {
    const failure = new Error("Connection lost")
    const connection = Object.assign(new EventEmitter(), {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    })
    const { agentInvocationPostgresClient } = await import("../src/invocations/postgres-clients.ts")
    const client = agentInvocationPostgresClient({ connect: async () => connection, query: vi.fn(), totalCount: 1 }, "DB")

    await expect(client.begin(async () => { connection.emit("error", failure) })).rejects.toBe(failure)
    expect(connection.query.mock.calls).toEqual([["BEGIN"]])
    expect(connection.release).toHaveBeenCalledExactlyOnceWith(true)
    expect(connection.listenerCount("error")).toBe(0)
  })

  describe.skipIf(!url)("on a Postgres server", () => {
    const pools: Array<{ end: () => Promise<void> }> = []
    const serverPrefix = `${prefix}drop_`
    const nodePostgres = () => {
      vi.stubEnv("VITEHUB_TEST_AGENT_DATABASE_URL", url!)
      const definition = defineDatabase({ connection: { url: { kind: "env-variable", source: { kind: "env", name: "VITEHUB_TEST_AGENT_DATABASE_URL" } } }, dialect: "postgresql", driver: "node-postgres", schema: {} })
      const db = createNodePostgresDatabase(definition, { binding: "DB" })
      pools.push(Reflect.get(db, "$client"))
      return db
    }
    afterAll(async () => {
      await nodePostgres().execute(`DROP TABLE IF EXISTS ${prefix}invocations_observations, ${prefix}invocations, ${serverPrefix}invocations_observations, ${serverPrefix}invocations`)
      await Promise.all(pools.map(pool => pool.end()))
    })

    it("stores Invocations on a node-postgres Database that two processes share", async () => {
      const [a, b] = [nodePostgres(), nodePostgres()]
      for (const statement of await journalMigration(prefix)) await a.execute(statement)
      await shareInvocationBetweenTwoProcesses({ a, b }, prefix)
    })

    it("rejects a journal update when its backend is terminated and reconnects", async () => {
      const [db, control] = [nodePostgres(), nodePostgres()]
      for (const statement of await journalMigration(serverPrefix)) await db.execute(statement)
      useDatabase.mockReturnValue({ db })
      const { createDatabaseAgentInvocationStore } = await import("../src/invocations/database.ts")
      const journal = createDatabaseAgentInvocationStore({ maxAge: false, maxRecords: false, tablePrefix: serverPrefix })
      await journal.create(invocation("interrupted"))
      const { rows: [backend] } = await db.execute("SELECT pg_backend_pid() AS pid") as { rows: [{ pid: number }] }

      await control.transaction(async (transaction) => {
        await transaction.execute(`LOCK TABLE ${serverPrefix}invocations IN ACCESS EXCLUSIVE MODE`)
        const update = Promise.resolve()
          .then(() => journal.update("interrupted", { status: "cancelled", timestamp }))
          .catch((error: unknown) => error)
        await vi.waitFor(async () => {
          const { rows: [activity] } = await transaction.execute(sql`SELECT cardinality(pg_blocking_pids(${backend.pid}::integer)) AS blockers`) as { rows: Array<{ blockers: number }> }
          expect(activity?.blockers).toBeGreaterThan(0)
        }, { timeout: 3_000 })
        const { rows: [termination] } = await transaction.execute(sql`SELECT pg_terminate_backend(${backend.pid}::integer) AS terminated`) as { rows: Array<{ terminated: boolean }> }
        expect(termination?.terminated).toBe(true)
        expect(await update).toBeInstanceOf(Error)
      })

      await expect(journal.get("interrupted")).resolves.toMatchObject({ status: "running" })
      await expect(journal.update("interrupted", { status: "cancelled", timestamp })).resolves.toMatchObject({ status: "cancelled" })
    })
  })
})
