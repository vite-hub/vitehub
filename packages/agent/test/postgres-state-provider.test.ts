import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { drizzle as drizzleProxy } from "drizzle-orm/pg-proxy"
import postgres from "postgres"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { defineDatabase } from "../../database/src/definition.ts"
import { createDevPostgresDatabase } from "../../database/src/runtime/pglite.ts"
import { POSTGRES_STATE_DATABASE_NOW } from "../src/internal/state-database-clock.ts"
import { createPostgresAgentState } from "../src/state/postgres.ts"
import { describeAgentStateBehavior, webhookDelivery } from "./support/agent-state-suite.ts"

import type { AgentStateFixture } from "./support/agent-state-suite.ts"
import type { SqliteAgentStateRow } from "../src/state/sqlite.ts"

const { useDatabase } = vi.hoisted(() => ({ useDatabase: vi.fn() }))
vi.mock("@vite-hub/database", () => ({ useDatabase }))

const url = process.env.VITEHUB_TEST_POSTGRES_URL
const tablePrefixDefault = "test_agent_state_"

type Parameters = Array<string | number | boolean | null>

interface RowsQuery { query(text: string, values?: Parameters): Promise<{ rows: SqliteAgentStateRow[] }> }
interface Pglite extends RowsQuery {
  exec(text: string): Promise<unknown>
  transaction<T>(run: (transaction: RowsQuery) => Promise<T>): Promise<T>
  close(): Promise<void>
}

function followFakeClock(statement: string): string {
  if (!vi.isFakeTimers() && !vi.isMockFunction(Date.now)) return statement
  return statement.replaceAll(POSTGRES_STATE_DATABASE_NOW, String(Date.now()))
}

function placeholders(statement: string): string {
  let index = 0
  return statement.replace(/\?/g, () => `$${++index}`)
}

function failInsertsSql(table: string, message: string): string[] {
  return [
    `CREATE FUNCTION fail_${table}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${message}'; END $$`,
    `CREATE TRIGGER fail_${table} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_${table}()`,
  ]
}

function restoreInsertsSql(table: string): string[] {
  return [`DROP TRIGGER fail_${table} ON ${table}`, `DROP FUNCTION fail_${table}()`]
}

let schemaIndex = 0
const schemaName = () => `agent_state_${process.pid}_${++schemaIndex}`

describe("Postgres Agent State on PGlite", () => {
  let dataDir: string
  let pglite: Pglite
  let schema: string | undefined
  const followed = (query: RowsQuery): RowsQuery => ({ query: (text, values) => query.query(followFakeClock(text), values) })

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "vitehub-agent-state-pglite-"))
    const definition = defineDatabase({ dialect: "postgresql", driver: "pglite", schema: {} })
    const db = await createDevPostgresDatabase(definition, { binding: "DB" }, { dataDir, migrationsDir: join(dataDir, "migrations") })
    pglite = Reflect.get(db, "$client")
  })

  afterAll(async () => {
    await pglite.close()
    rmSync(dataDir, { force: true, recursive: true })
  })

  it("claims queued deliveries with opaque input and settles superseded deliveries", async () => {
    const state = createPostgresAgentState({ client: pglite, tablePrefix: "opaque_" })
    await state.connect()
    const opaque = "null\0, literal \\u0000, and lone surrogate \ud800"
    const superseded = { ...webhookDelivery("superseded", undefined, opaque), channelDeliveryId: opaque, invocation: { input: opaque } }
    const affected = { ...superseded, deliveryId: "affected" }
    const ordinary = webhookDelivery("ordinary")
    for (const delivery of [superseded, affected, ordinary]) await expect(state.enqueueWebhookDelivery(delivery)).resolves.toBe(true)
    await expect(state.claimWebhookDelivery(affected.scope)).resolves.toMatchObject({ deliveryId: "affected", invocation: { input: opaque } })
    await expect(state.claimWebhookDelivery(affected.scope)).resolves.toMatchObject({ deliveryId: "ordinary" })
    await expect(state.pendingWebhookDeliverySettlements(affected.scope)).resolves.toEqual([{ channelDeliveryId: opaque, deliveryId: "superseded" }])
  })

  it("opens a provisioned schema without schema CREATE privileges", async () => {
    const provisioner = createPostgresAgentState({ client: pglite, tablePrefix: "provisioned_" })
    await pglite.exec("CREATE SCHEMA provisioned; SET search_path TO provisioned; CREATE ROLE state_runtime")
    try {
      await provisioner.connect()
      await pglite.exec("GRANT USAGE ON SCHEMA provisioned TO state_runtime; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA provisioned TO state_runtime; SET ROLE state_runtime")
      const state = createPostgresAgentState({ client: pglite, tablePrefix: "provisioned_" })
      await state.connect()
      await state.set("key", "value")
      await expect(state.get("key")).resolves.toBe("value")
    }
    finally {
      await pglite.exec("RESET ROLE; SET search_path TO public; DROP SCHEMA provisioned CASCADE; DROP ROLE state_runtime")
    }
  })

  describeAgentStateBehavior({
    name: "PGlite",
    fakeTimers: { toFake: ["Date"] },
    async create(tablePrefix = tablePrefixDefault): Promise<AgentStateFixture> {
      schema = schemaName()
      await pglite.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`)
      const client = { exec: (text: string) => pglite.exec(followFakeClock(text)), ...followed(pglite), transaction: <T>(run: (transaction: RowsQuery) => Promise<T>) => pglite.transaction(transaction => run(followed(transaction))) }
      const open = (options = {}) => createPostgresAgentState({ ...options, client, durable: false, tablePrefix })
      const sql = async (statement: string, args: unknown[] = []) => (await pglite.query(placeholders(statement), args as Parameters)).rows
      return {
        failInserts: async (table, message) => {
          for (const statement of failInsertsSql(table, message)) await pglite.exec(statement)
          return async () => { for (const statement of restoreInsertsSql(table)) await pglite.exec(statement) }
        },
        reopen: open,
        sql,
        state: open(),
      }
    },
    async cleanup() {
      if (!schema) return
      await pglite.exec(`SET search_path TO public; DROP SCHEMA ${schema} CASCADE`)
      schema = undefined
    },
  })
})

describe.skipIf(!url)("Postgres Agent State on a Postgres server", () => {
  const admin = postgres(url ?? "postgres://localhost/unused", { max: 1, onnotice: () => {} })
  const clients: ReturnType<typeof postgres>[] = []
  const schemas: string[] = []

  async function connection(schema: string, max = 4) {
    const sql = postgres(url!, { connection: { search_path: schema }, max, onnotice: () => {} })
    clients.push(sql)
    return sql
  }

  async function freshSchema(): Promise<string> {
    const schema = schemaName()
    await admin.unsafe(`CREATE SCHEMA ${schema}`)
    schemas.push(schema)
    return schema
  }

  async function cleanup() {
    await Promise.all(clients.splice(0).map(client => client.end()))
    for (const schema of schemas.splice(0)) await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  }

  afterAll(async () => {
    await cleanup()
    await admin.end()
  })

  describeAgentStateBehavior({
    name: "Postgres",
    fakeTimers: { toFake: ["Date"] },
    async create(tablePrefix = tablePrefixDefault): Promise<AgentStateFixture> {
      const schema = await freshSchema()
      const [stateClient, inspection] = [await connection(schema), await connection(schema, 1)]
      type Unsafe = Pick<typeof stateClient, "unsafe">
      const followed = (query: Unsafe) => ({ unsafe: (text: string, values?: Parameters) => query.unsafe(followFakeClock(text), values) })
      const client = Object.assign(() => undefined, {
        ...followed(stateClient),
        begin: <T>(run: (transaction: ReturnType<typeof followed>) => Promise<T>) => stateClient.begin(transaction => run(followed(transaction))),
      })
      const open = (options = {}) => createPostgresAgentState({ ...options, client, tablePrefix })
      const sql = async (statement: string, args: unknown[] = []) => [...await inspection.unsafe(placeholders(statement), args as Parameters)]
      return {
        failInserts: async (table, message) => {
          for (const statement of failInsertsSql(table, message)) await inspection.unsafe(statement)
          return async () => { for (const statement of restoreInsertsSql(table)) await inspection.unsafe(statement) }
        },
        reopen: open,
        sql,
        state: open(),
      }
    },
    cleanup,
  })

  describe("with two servers on one Database", () => {
    afterEach(async () => {
      vi.restoreAllMocks()
      await cleanup()
    })

    async function twoServers() {
      const schema = await freshSchema()
      const [a, b] = [createPostgresAgentState({ client: await connection(schema, 2) }), createPostgresAgentState({ client: await connection(schema, 2) })]
      await Promise.all([a.connect(), b.connect()])
      return { a, b }
    }

    it("gives one lock, one queue claim, and one admission to two contending servers", async () => {
      const { a, b } = await twoServers()

      for (let round = 0; round < 25; round++) {
        const locks = await Promise.all([a.acquireLock("thread", 30_000), b.acquireLock("thread", 30_000)])
        expect(locks.filter(Boolean)).toHaveLength(1)
        await (locks[0] ? a : b).releaseLock(locks.find(Boolean)!)
      }

      for (let round = 0; round < 10; round++) {
        const delivery = webhookDelivery(`contended-${round}`, `key-${round}`)
        const admitted = await Promise.all([a.enqueueWebhookDelivery(delivery), b.enqueueWebhookDelivery(delivery)])
        expect(admitted.filter(Boolean)).toHaveLength(1)
        const claims = await Promise.all([a.claimWebhookDelivery(delivery.scope), b.claimWebhookDelivery(delivery.scope)])
        expect(claims.filter(Boolean).map(claim => claim!.deliveryId)).toEqual([delivery.deliveryId])
        const claim = claims.find(Boolean)!
        await expect(a.completeWebhookDelivery(claim.scope, claim.deliveryId, claim.leaseToken)).resolves.toBe(true)
      }

      await Promise.all([a.disconnect(), b.disconnect()])
    }, 30_000)

    it("decides expiry with the database clock when the server clocks disagree", async () => {
      const { a, b } = await twoServers()
      const hour = 60 * 60 * 1_000
      const realNow = Date.now.bind(Date)

      const lock = await a.acquireLock("thread", 1_000)
      expect(lock).not.toBeNull()
      await a.set("session", "open", 1_000)
      const ahead = vi.spyOn(Date, "now").mockImplementation(() => realNow() + hour)
      await expect(b.acquireLock("thread", 1_000)).resolves.toBeNull()
      await expect(b.get("session")).resolves.toBe("open")

      ahead.mockImplementation(() => realNow() - hour)
      await new Promise(resolve => setTimeout(resolve, 1_200))
      await expect(b.get("session")).resolves.toBeNull()
      await expect(b.acquireLock("thread", 1_000)).resolves.toMatchObject({ threadId: "thread" })

      await Promise.all([a.disconnect(), b.disconnect()])
    })

    it("shares one concurrency limit across scopes with repeatable-read client defaults and mixed-case prefixes", async () => {
      const schema = await freshSchema()
      const first = await connection(schema, 1)
      const second = await connection(schema, 1)
      for (const sql of [first, second]) await sql.unsafe("SET default_transaction_isolation = 'repeatable read'")
      const a = createPostgresAgentState({ client: first, tablePrefix: "Mixed_" })
      const b = createPostgresAgentState({ client: second, tablePrefix: "mixed_" })
      await Promise.all([a.connect(), b.connect()])
      const delivery = { ...webhookDelivery("first", "shared"), concurrencyLimit: 1 }
      await a.enqueueWebhookDelivery(delivery)
      await b.enqueueWebhookDelivery({ ...delivery, deliveryId: "second", scope: "other" })
      await expect(first.unsafe("SHOW default_transaction_isolation")).resolves.toMatchObject([{ default_transaction_isolation: "repeatable read" }])
      const claims = await Promise.all([a.claimWebhookDelivery(delivery.scope), b.claimWebhookDelivery("other")])
      expect(claims.filter(Boolean)).toHaveLength(1)
    })

    it("waits for an uncommitted list tail before cleaning up an expired list", async () => {
      const schema = await freshSchema()
      const writer = await connection(schema, 1)
      const cleaner = await connection(schema, 1)
      const a = createPostgresAgentState({ client: writer })
      const b = createPostgresAgentState({ client: cleaner })
      await Promise.all([a.connect(), b.connect()])
      const [cleanerBackend] = await cleaner`SELECT pg_backend_pid() AS pid`
      await writer`INSERT INTO vitehub_agent_state_lists (key, value, expires_at) VALUES ('list', '"old"', 0)`

      const inserted = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const append = a.extension("test").transaction(async (tx) => {
        await tx.execute(`INSERT INTO vitehub_agent_state_lists (key, value, expires_at) VALUES ('list', '"fresh"', NULL)`)
        inserted.resolve()
        await release.promise
      })
      await Promise.race([inserted.promise, append])
      let finished = false
      const cleanup = b.cleanupExpiredState().finally(() => { finished = true })
      try {
        await vi.waitFor(async () => {
          const locks = await admin`SELECT 1 FROM pg_locks WHERE pid = ${cleanerBackend!.pid} AND locktype = 'advisory' AND NOT granted`
          expect(finished || locks.length > 0).toBe(true)
        }, { timeout: 5_000 })
      }
      finally {
        release.resolve()
        await Promise.all([append, cleanup])
      }
      await expect(b.getList("list")).resolves.toEqual(["old", "fresh"])
    })
  })
})

describe("Agent State in a ViteHub Database", () => {
  afterEach(() => {
    useDatabase.mockReset()
  })

  it("uses the Postgres Database and creates its tables on first use", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "vitehub-agent-state-database-"))
    try {
      const definition = defineDatabase({ dialect: "postgresql", driver: "pglite", schema: {} })
      const db = await createDevPostgresDatabase(definition, { binding: "DB" }, { dataDir, migrationsDir: join(dataDir, "migrations") })
      useDatabase.mockReturnValue({ db })
      const { createDatabaseAgentState } = await import("../src/state/postgres.ts")
      const state = createDatabaseAgentState()
      await state.connect()
      await state.set("seen", { id: 1 })
      await expect(state.get("seen")).resolves.toEqual({ id: 1 })
      expect(useDatabase).toHaveBeenCalledWith("default")
      expect(state.durable).toBe(true)
      expect(state.extension("babysitter")).toMatchObject({ dialect: "postgresql", tablePrefix: "vitehub_agent_state_babysitter_" })
      await expect(state.extension("babysitter").execute("SELECT $1::text AS value", [new Date(0)])).rejects.toMatchObject({ code: "AGENT_STATE_POSTGRES_VALUE_UNSUPPORTED", message: expect.stringContaining("Date") })
      await state.disconnect()
      await Reflect.get(db, "$client").close()
    }
    finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  it("fails with a code when the Database does not run on Postgres", async () => {
    useDatabase.mockReturnValue({ db: {} })
    const { createDatabaseAgentState } = await import("../src/state/postgres.ts")
    await expect(createDatabaseAgentState({ database: "sqlite" }).connect()).rejects.toMatchObject({ code: "AGENT_STATE_DATABASE_NOT_POSTGRES" })
  })

  it("fails with a code when the Postgres driver has no client that the store can use", async () => {
    useDatabase.mockReturnValue({ db: drizzleProxy(async () => ({ rows: [] })) })
    const { createDatabaseAgentState } = await import("../src/state/postgres.ts")
    await expect(createDatabaseAgentState({ database: "proxy" }).connect()).rejects.toMatchObject({ code: "AGENT_STATE_POSTGRES_DRIVER_UNSUPPORTED" })
  })

  it("rejects a table prefix that Postgres would cut", () => {
    expect(() => createPostgresAgentState({ client: {}, tablePrefix: `${"x".repeat(34)}_` })).toThrow("longer than 33 characters")
  })
})
