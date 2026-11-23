import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { defineDatabase } from "../../database/src/definition.ts"
import { createNodePostgresDatabase } from "../../database/src/runtime/node-postgres.ts"
import { createDevPostgresDatabase } from "../../database/src/runtime/pglite.ts"
import { agentInvocationsDurability } from "../src/durability.ts"
import { postgresAgentInvocationTables } from "../src/invocations/postgres.ts"

import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"
import type { AgentInvocations } from "../src/invocations.ts"

const useDatabase = vi.fn()
vi.mock("@vite-hub/database", () => ({ useDatabase }))

const url = process.env.VITEHUB_TEST_POSTGRES_URL
const globalKeys = ["database-store", "default", "override"].map(name => Symbol.for(`vitehub.agent.invocations.${name}`))

async function nodeServer(db: object, projectRoot: string): Promise<{ invocations: AgentInvocations, bind: typeof import("../src/invocations.ts").bindAgentInvocations }> {
  vi.resetModules()
  for (const key of globalKeys) Reflect.deleteProperty(globalThis, key)
  useDatabase.mockImplementation((name: string) => {
    if (name !== "default") throw new Error(`Unexpected Database ${name}`)
    return { db }
  })
  const { getAgentInvocations, installAgentInvocations } = await import("../src/invocations/app.ts")
  installAgentInvocations({ database: async () => await import("../src/invocations/database.ts"), journal: { database: "default", projectRoot } })
  const { bindAgentInvocations } = await import("../src/invocations.ts")
  return { bind: bindAgentInvocations, invocations: getAgentInvocations() }
}

async function journalMigration(): Promise<string[]> {
  return await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ ...postgresAgentInvocationTables() }))
}

async function shareDefaultJournal(databases: { a: object, b: object }, projectRoot: string) {
  const a = await nodeServer(databases.a, projectRoot)
  const runId = `default-postgres-${process.pid}-${Date.now()}`
  const journal = await a.bind(a.invocations, { memo: vi.fn(), run: { runId }, runtime: "unknown", waitUntil: vi.fn() }, { agentName: "support" })
  if (!journal) throw new Error("Expected the default journal")
  await journal.running()
  const started = await a.invocations.getByRunId(runId, "support")
  if (!started) throw new Error("Expected the Invocation on process A")

  const b = await nodeServer(databases.b, projectRoot)
  const read = await b.invocations.get(started.id)
  expect(read).toMatchObject({ agentName: "support", status: "running" })
  await expect(b.invocations.cancel(started.id)).resolves.toMatchObject({ outcome: "requested" })
  await expect(a.invocations.get(started.id)).resolves.toMatchObject({ cancelRequestedAt: expect.any(String) })
  await journal.finish("cancelled")
  const finished = await b.invocations.get(started.id)
  expect(finished).toMatchObject({ status: "cancelled" })
  await expect(a.invocations.get(started.id)).resolves.toMatchObject({ status: "cancelled" })
}

function context(env: Record<string, string | undefined>, reports: readonly Durability[]): DurabilityContext {
  return { env, find: (primitive, name = "default") => reports.find(report => report.primitive === primitive && (report.name ?? "default") === name) }
}

describe("default Agent journal on a Postgres default Database", () => {
  let projectRoot: string
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "vitehub-agent-default-postgres-"))
    useDatabase.mockReset()
  })
  afterEach(() => {
    for (const key of globalKeys) Reflect.deleteProperty(globalThis, key)
    rmSync(projectRoot, { force: true, recursive: true })
  })

  it("stores Invocations in a PGlite default Database, not in the local file", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "vitehub-agent-default-pglite-"))
    try {
      const definition = defineDatabase({ dialect: "postgresql", driver: "pglite", schema: {} })
      const db = await createDevPostgresDatabase(definition, { binding: "DB" }, { dataDir, migrationsDir: join(dataDir, "migrations") })
      const client: { exec: (sql: string) => Promise<unknown>, close: () => Promise<void> } = Reflect.get(db, "$client")
      for (const statement of await journalMigration()) await client.exec(statement)
      try {
        await shareDefaultJournal({ a: db, b: db }, projectRoot)
        const { resolveDefaultAgentInvocationsLocation } = await import("../src/invocations/default-core.ts")
        await expect(resolveDefaultAgentInvocationsLocation({ database: { name: "default", store: vi.fn() }, env: {}, projectRoot })).resolves.toEqual({ url: "database:default" })
      }
      finally {
        await client.close()
      }
    }
    finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  it("reports the Database scope, and the env var URL when it moves the journal", () => {
    const input = { database: "default", defaultJournal: true, store: "database" } as const
    const postgres: Durability = { primitive: "database", reason: "A Postgres server.", scope: "shared", store: "postgres" }
    const pglite: Durability = { primitive: "database", reason: "PGlite in this process.", scope: "process", store: "pglite" }
    expect(agentInvocationsDurability(input, context({}, [postgres]))).toMatchObject([{ scope: "shared", store: "database (postgres)" }])
    expect(agentInvocationsDurability(input, context({}, [pglite]))).toMatchObject([{ scope: "process", store: "database (pglite)" }])
    expect(agentInvocationsDurability(input, context({ VITEHUB_AGENT_INVOCATIONS_DATABASE_URL: "file:/srv/journal.sqlite" }, [postgres]))).toMatchObject([{ scope: "host", store: "sqlite" }])
    expect(agentInvocationsDurability({ store: "database" }, context({ VITEHUB_AGENT_INVOCATIONS_DATABASE_URL: "file:/srv/journal.sqlite" }, [postgres]))).toMatchObject([{ scope: "shared" }])
  })

  it("keeps the local file when the env var moves the journal or no Database is set", async () => {
    const { resolveDefaultAgentInvocationsLocation } = await import("../src/invocations/default-core.ts")
    const database = { name: "default", store: vi.fn() }
    await expect(resolveDefaultAgentInvocationsLocation({ database, env: { VITEHUB_AGENT_INVOCATIONS_DATABASE_URL: "libsql://journal.example.com" }, projectRoot })).resolves.toEqual({ url: "libsql://journal.example.com" })
    await expect(resolveDefaultAgentInvocationsLocation({ env: {}, projectRoot })).resolves.toMatchObject({ url: expect.stringContaining(".vitehub/data/agent-invocations.sqlite") })
    expect(database.store).not.toHaveBeenCalled()
  })

  it("rejects retention.maxSize, because the Database holds other tables", async () => {
    const { createDefaultAgentInvocations } = await import("../src/invocations/default-core.ts")
    expect(() => createDefaultAgentInvocations({ database: { name: "default", store: vi.fn() }, env: {}, projectRoot, retention: { maxSize: "1GB" } })).toThrow(expect.objectContaining({ code: "AGENT_R1027" }))
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
      await Promise.all(pools.map(pool => pool.end()))
    })

    it("shares the default journal between two processes with their own connections", async () => {
      const [a, b] = [nodePostgres(), nodePostgres()]
      await a.execute("DROP TABLE IF EXISTS vitehub_agent_invocations_observations, vitehub_agent_invocations")
      for (const statement of await journalMigration()) await a.execute(statement)
      await shareDefaultJournal({ a, b }, projectRoot)
    })
  })
})
