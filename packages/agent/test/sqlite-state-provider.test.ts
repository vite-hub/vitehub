import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { pathToFileURL } from "node:url"

import { createClient } from "@libsql/client"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@libsql/client", async importOriginal => {
  const actual = await importOriginal<typeof import("@libsql/client")>()
  const { followFakeClockClient } = await import("./support/state-database-clock.ts")
  return { ...actual, createClient: vi.fn(followFakeClockClient(actual.createClient)) }
})

import { createLibsqlAgentState, createSqliteAgentState, type LibsqlAgentStateClient, type SqliteAgentStateDriver, ViteHubSqliteAgentStateAdapter } from "../src/state/sqlite.ts"

import { describeAgentStateBehavior, webhookDelivery } from "./support/agent-state-suite.ts"

const tempDirs: string[] = []

async function createState(tablePrefix = "test_agent_state_"): Promise<{ state: ViteHubSqliteAgentStateAdapter; url: string }> {
  const dir = await mkdtemp(join(tmpdir(), "vitehub-agent-state-"))
  tempDirs.push(dir)
  const url = `file:${join(dir, "state.db")}`
  return {
    state: createLibsqlAgentState({ tablePrefix, url }),
    url,
  }
}

describeAgentStateBehavior({
  name: "libSQL",
  async create(tablePrefix = "test_agent_state_") {
    const { state, url } = await createState(tablePrefix)
    const sql = async (statement: string, args: unknown[] = []) => {
      const client = createClient({ url })
      try {
        // SAFETY: The suite passes only SQL scalars as arguments.
        return (await client.execute({ args: args as never, sql: statement })).rows
      }
      finally {
        client.close()
      }
    }
    return {
      failInserts: async (table, message) => {
        await sql(`CREATE TRIGGER fail_${table} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(FAIL, '${message}'); END`)
        return async () => { await sql(`DROP TRIGGER fail_${table}`) }
      },
      reopen: options => createLibsqlAgentState({ ...options, tablePrefix, url }),
      sql,
      state,
    }
  },
  cleanup: async () => { await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true }))) },
})

describe("SQLite Agent State Provider", () => {
  afterEach(async () => {
    vi.useRealTimers()
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
  })

  it("coordinates independent file adapters across URL forms and reconnects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vitehub-state-writers-"))
    tempDirs.push(dir)
    const path = join(dir, "state data.db")
    const first = createLibsqlAgentState({ url: `file:${pathToFileURL(path).pathname}?tls=0` })
    const second = createLibsqlAgentState({ url: pathToFileURL(path).href.replace(/^file:/, "FILE:") })
    try {
      await first.connect()
      await second.connect()
      for (let round = 0; round < 2; round++) {
        await Promise.all([first, second].map(async (state, index) => {
          for (let n = 0; n < 3; n++) await state.set(`writer-${round}-${index}-${n}`, { n })
        }))
        await expect(first.get(`writer-${round}-1-2`)).resolves.toEqual({ n: 2 })
        await expect(second.get(`writer-${round}-0-2`)).resolves.toEqual({ n: 2 })
        await second.disconnect()
        await second.connect()
      }
      await expect(first.extension("writer").transaction(async () => {
        throw new Error("rollback probe")
      })).rejects.toThrow("rollback probe")
      await second.set("after-rollback", true)
      await expect(first.get("after-rollback")).resolves.toBe(true)
    } finally {
      await first.disconnect()
      await second.disconnect()
    }
  })

  it.each(["file::memory:?cache=shared", "FILE:%3Amemory%3A?%63ache=shared", "file::memory:?cache=private&cache=shared"])("coordinates shared memory adapters using %s", async url => {
    const first = createLibsqlAgentState({ url: "file::memory:?cache=shared" })
    const second = createLibsqlAgentState({ url })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    try {
      await first.connect()
      await second.connect()
      await first.set("message", "before")
      await expect(second.get("message")).resolves.toBe("before")
      const write = first.extension("probe").transaction(async tx => {
        await tx.execute("UPDATE vitehub_agent_state_cache SET value = ? WHERE key = ?", [JSON.stringify("after"), "message"])
        enter()
        await gate
      })
      await entered
      let readFinished = false
      const read = second.get("message").then(value => {
        readFinished = true
        return { value }
      }, error => {
        readFinished = true
        return { code: error.code }
      })
      await new Promise<void>(resolve => setImmediate(resolve))
      const finishedDuringTransaction = readFinished
      release()
      await write
      expect(finishedDuringTransaction).toBe(false)
      await expect(read).resolves.toEqual({ value: "after" })
      await second.disconnect()
      await second.connect()
      await expect(second.get("message")).resolves.toBe("after")
    } finally {
      release()
      await first.disconnect()
      await second.disconnect()
    }
  })

  it.each([":memory:", "file::memory:", "FILE::memory:", "file::memory:?cache=private", "file::memory:?cache=shared&cache=private"])("queues reads behind a %s transaction without blocking independent clients", async url => {
    const state = createLibsqlAgentState({ url })
    const independent = createLibsqlAgentState({ url })
    await state.connect()
    await independent.connect()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    try {
      await state.set("message", "before")
      const write = state.extension("probe").transaction(async tx => {
        await tx.execute("UPDATE vitehub_agent_state_cache SET value = ? WHERE key = ?", [JSON.stringify("after"), "message"])
        enter()
        await gate
      })
      await entered
      let readFinished = false
      const read = state.get("message").then(value => {
        readFinished = true
        return { value }
      }, error => {
        readFinished = true
        return { code: error.code }
      })
      await independent.set("message", "independent")
      await expect(independent.get("message")).resolves.toBe("independent")
      await new Promise<void>(resolve => setImmediate(resolve))
      const finishedDuringTransaction = readFinished
      release()
      await write
      expect(finishedDuringTransaction).toBe(false)
      await expect(read).resolves.toEqual({ value: "after" })
    } finally {
      release()
      await state.disconnect()
      await independent.disconnect()
    }
  })

  it("declares persistence only for known durable storage or explicit custom storage", () => {
    for (const url of [":memory:", "file::memory:", "file:test?mode=memory"]) {
      expect(createLibsqlAgentState({ url, durable: true }).durable).toBe(false)
    }
    for (const url of ["file:state.db", "libsql://database.example"]) {
      expect(createLibsqlAgentState({ url }).durable).toBe(true)
      expect(createLibsqlAgentState({ url, durable: false }).durable).toBe(false)
    }
    const client: LibsqlAgentStateClient = {
      execute: () => ({ rows: [] }),
      transaction: () => ({ execute: () => ({ rows: [] }), commit: () => {}, rollback: () => {} }),
    }
    expect(createLibsqlAgentState({ client }).durable).toBe(false)
    expect(createLibsqlAgentState({ client, url: "file:unused.db" }).durable).toBe(false)
    expect(createLibsqlAgentState({ client, durable: true }).durable).toBe(true)
    const driver: SqliteAgentStateDriver = { execute: () => ({ rows: [] }) }
    expect(createSqliteAgentState({ driver }).durable).toBe(false)
    expect(createSqliteAgentState({ driver, durable: true }).durable).toBe(true)
  })

  it("commits WAL write transactions with synchronous NORMAL", async () => {
    const { url } = await createState()
    const state = createLibsqlAgentState({ url })
    await state.connect()
    try {
      const levels = new Set<number>()
      for (let index = 0; index < 5; index++) {
        await state.extension("probe").transaction(async tx => {
          levels.add(Number((await tx.execute("PRAGMA synchronous"))[0]?.synchronous))
        })
      }
      expect([...levels]).toEqual([1])
    } finally {
      await state.disconnect()
    }
  })

  it("keeps rollback journaling available for network-backed volumes", async () => {
    const { url } = await createState()
    const state = createLibsqlAgentState({ url, journalMode: "delete" })
    await state.connect()
    const client = createClient({ url })
    try {
      expect((await client.execute("PRAGMA journal_mode")).rows[0]?.journal_mode).toBe("delete")
      await state.set("network-volume", "persisted")
      await expect(state.get("network-volume")).resolves.toBe("persisted")
    } finally {
      client.close()
      await state.disconnect()
    }
  })

  it.each(["wal", "delete"] as const)("rejects a VFS that silently retains a different journal mode than %s", async journalMode => {
    const { url } = await createState()
    // A real memory VFS returns 'memory' even when PRAGMA requests WAL.
    const opened = createClient({ url: "file::memory:" })
    const close = vi.spyOn(opened, "close")
    const factory = vi.mocked(createClient).mockReturnValueOnce(opened)
    const state = createLibsqlAgentState({ url, journalMode })
    try {
      await expect(state.connect()).rejects.toMatchObject({ code: "AGENT_R0947" })
      expect(close).toHaveBeenCalledOnce()
    } finally {
      factory.mockClear()
      await state.disconnect()
      opened.close()
    }
  })

  it("waits for a legacy reader before switching to WAL", async () => {
    const { url } = await createState()
    const legacy = createLibsqlAgentState({ url, journalMode: "delete", tablePrefix: "test_agent_state_" })
    await legacy.connect()
    await legacy.set("snapshot", "before")
    const client = createClient({ url })
    const reader = await client.transaction("read")
    await reader.execute("SELECT value FROM test_agent_state_cache")
    const upgraded = createLibsqlAgentState({ url, tablePrefix: "test_agent_state_" })
    // Hold the rollback-journal snapshot beyond the ordinary write retry budget.
    const release = new Promise<void>((resolve, reject) => setTimeout(() => {
      void reader.rollback().then(resolve, reject)
    }, 350))
    try {
      await expect(upgraded.connect()).resolves.toBeUndefined()
      await release
      const inspection = createClient({ url })
      try {
        expect((await inspection.execute("PRAGMA journal_mode")).rows[0]?.journal_mode).toBe("wal")
      } finally { inspection.close() }
      await expect(upgraded.get("snapshot")).resolves.toBe("before")
    } finally {
      await release
      reader.close()
      client.close()
      await upgraded.disconnect()
      await legacy.disconnect()
    }
  })

  it("commits state while another connection retains a read snapshot", async () => {
    const { state, url } = await createState()
    await state.connect()
    await state.set("snapshot", "before")
    const client = createClient({ url })
    const reader = await client.transaction("read")
    try {
      expect((await reader.execute("SELECT value FROM test_agent_state_cache WHERE key = 'snapshot'")).rows[0]?.value).toBe(JSON.stringify("before"))
      await expect(state.set("snapshot", "after")).resolves.toBeUndefined()
      expect((await reader.execute("SELECT value FROM test_agent_state_cache WHERE key = 'snapshot'")).rows[0]?.value).toBe(JSON.stringify("before"))
      await expect(state.get("snapshot")).resolves.toBe("after")
    } finally {
      await reader.rollback()
      reader.close()
      client.close()
      await state.disconnect()
    }
  })

  it("retries transient SQLite contention while persisting webhook deliveries", async () => {
    const client = createClient({ url: ":memory:" })
    let busyCompletion = true
    let busyCleanup = false
    let busyEnqueue = true
    let busyRetry = true
    let busyRelease = true
    let busySteering = true
    let busyLock = true
    const execute = vi.fn(async (
      statement: string,
      args?: unknown[],
      executor: Pick<typeof client, "execute"> = client,
    ) => {
      if (busyLock && statement.includes("INSERT INTO test_agent_state_locks")) {
        busyLock = false
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
      }
      if (busySteering && statement.includes("ON CONFLICT DO NOTHING") && statement.includes("'steering'")) {
        busySteering = false
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
      }
      if (busyRelease && statement.includes("DELETE FROM test_agent_state_locks WHERE thread_id = ? AND token = ?")) {
        busyRelease = false
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
      }
      if (busyEnqueue && statement.includes("INSERT INTO test_agent_state_webhook_queue") && !statement.includes("'steering'")) {
        busyEnqueue = false
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
      }
      if (busyCleanup && statement.includes("DELETE FROM test_agent_state_locks")) {
        busyCleanup = false
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
      }
      if (busyCompletion && statement.includes("SET status = 'completed'")) {
        busyCompletion = false
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
      }
      if (busyRetry && statement.includes("SET status = 'queued'")) {
        busyRetry = false
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
      }
      // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
      return await executor.execute({ args: (args || []) as never, sql: statement })
    })
    const contended = createSqliteAgentState({
      driver: {
        connect: async () => undefined,
        execute,
        async transaction(run) {
          const transaction = await client.transaction("write")
          try {
            const result = await run({
              execute: async (statement, args) => await execute(statement, args, transaction),
            })
            await transaction.commit()
            return result
          } catch (error) {
            await transaction.rollback().catch(() => undefined)
            throw error
          } finally {
            transaction.close()
          }
        },
      },
      tablePrefix: "test_agent_state_",
    })
    await contended.connect()
    expect(execute.mock.calls.some(([statement]) => statement.includes("_active_scope"))).toBe(true)
    const contendedLock = await contended.acquireLock("contended", 1_000)
    expect(contendedLock).toMatchObject({ threadId: "contended" })
    expect(execute.mock.calls.filter(([statement]) => String(statement).includes("INSERT INTO test_agent_state_locks"))).toHaveLength(2)
    await expect(contended.releaseLock(contendedLock!)).resolves.toBeUndefined()
    expect(
      execute.mock.calls.filter(([statement]) => String(statement).includes("DELETE FROM test_agent_state_locks WHERE thread_id = ? AND token = ?")),
    ).toHaveLength(2)

    Reflect.set(contended, "nextCleanupAt", 0)
    busyCleanup = true
    await expect(contended.enqueueWebhookDelivery(webhookDelivery("delivery-busy"))).resolves.toBe(true)
    expect(execute.mock.calls.filter(([statement]) => String(statement).includes("INSERT INTO test_agent_state_webhook_queue") && !String(statement).includes("'steering'"))).toHaveLength(2)
    const lease = await contended.claimWebhookDelivery("webhook:review:github:")
    Reflect.set(contended, "nextCleanupAt", 0)
    busyCleanup = true
    await expect(contended.completeWebhookDelivery(lease!.scope, lease!.deliveryId, lease!.leaseToken)).resolves.toBe(true)
    expect(execute.mock.calls.filter(([statement]) => String(statement).includes("SET status = 'completed'"))).toHaveLength(2)
    await expect(contended.enqueueWebhookDelivery(webhookDelivery("delivery-retry-busy"))).resolves.toBe(true)
    const retryLease = await contended.claimWebhookDelivery("webhook:review:github:")
    Reflect.set(contended, "nextCleanupAt", 0)
    busyCleanup = true
    await expect(contended.retryWebhookDelivery(retryLease!.scope, retryLease!.deliveryId, retryLease!.leaseToken, Date.now())).resolves.toBe(true)
    expect(execute.mock.calls.filter(([statement]) => String(statement).includes("SET status = 'queued'"))).toHaveLength(2)
    expect(execute.mock.calls.some(([statement]) => String(statement).startsWith("DELETE FROM test_agent_state_locks WHERE expires_at <= CAST("))).toBe(true)
    Reflect.set(contended, "nextCleanupAt", 0)
    busyCleanup = true
    await expect(contended.claimWebhookSteering(webhookDelivery("steering-busy"), "steer-token", Date.now() + 1_000)).resolves.toBe(true)
    expect(execute.mock.calls.filter(([statement]) => String(statement).includes("ON CONFLICT DO NOTHING") && String(statement).includes("'steering'"))).toHaveLength(
      2,
    )
    client.close()
  })

  it("migrates the production-patched webhook queue to database ordering", async () => {
    const { state, url } = await createState()
    await state.connect()
    await state.disconnect()
    const client = createClient({ url })
    const delivery = webhookDelivery("patched-delivery")
    await client.execute("DELETE FROM test_agent_state_schema_version WHERE version >= 4")
    await client.execute("DROP TABLE test_agent_state_webhook_queue")
    await client.execute(`CREATE TABLE test_agent_state_webhook_queue (
      scope TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      value TEXT NOT NULL,
      concurrency_group TEXT NOT NULL,
      concurrency_key TEXT,
      concurrency_limit INTEGER NOT NULL,
      lease_ttl_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      enqueued_at INTEGER NOT NULL,
      available_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,
      lease_expires_at INTEGER,
      PRIMARY KEY (scope, delivery_id)
    )`)
    await client.execute({
      args: [
        delivery.scope,
        delivery.deliveryId,
        JSON.stringify(delivery),
        delivery.concurrencyGroup,
        delivery.concurrencyKey || null,
        delivery.concurrencyLimit,
        delivery.leaseTtlMs,
        delivery.enqueuedAt,
        delivery.enqueuedAt,
      ],
      sql: `INSERT INTO test_agent_state_webhook_queue (
        scope, delivery_id, value, concurrency_group, concurrency_key, concurrency_limit,
        lease_ttl_ms, status, enqueued_at, available_at, attempts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0)`,
    })
    client.close()

    const restored = createLibsqlAgentState({ tablePrefix: "test_agent_state_", url })
    await restored.connect()
    await expect(restored.claimWebhookDelivery(delivery.scope)).resolves.toMatchObject({ deliveryId: "patched-delivery" })
    await restored.disconnect()
  })

  it("requires custom libSQL clients to support transactions", async () => {
    const state = createLibsqlAgentState({
      // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
      client: {
        async execute() {
          return { rows: [] }
        },
      } as never,
    })

    await expect(state.connect()).rejects.toThrow("libSQL Agent State clients must support transactions")
  })

  it("can reconnect an owned libSQL client after disconnect", async () => {
    const { state } = await createState()
    await state.connect()
    await state.set("seen", "yes")
    await state.disconnect()

    await state.connect()
    await expect(state.get("seen")).resolves.toBe("yes")
    await state.disconnect()
  })

  it("shares concurrent connect attempts", async () => {
    let inTransaction = false
    let migrations = 0
    const driver: SqliteAgentStateDriver = {
      async execute(statement: string) {
        if (statement.includes("COALESCE(MAX(version)")) return { rows: [{ version: 2 }] }
        return { rows: [] }
      },
      async transaction(run) {
        if (inTransaction) throw new Error("concurrent migration")
        inTransaction = true
        try {
          migrations += 1
          await new Promise((resolve) => setTimeout(resolve, 10))
          return await run(driver)
        } finally {
          inTransaction = false
        }
      },
    }
    const adapter = new ViteHubSqliteAgentStateAdapter({ driver })

    await expect(Promise.all([adapter.connect(), adapter.connect()])).resolves.toEqual([undefined, undefined])
    expect(migrations).toBe(1)
    await adapter.disconnect()
  })

  it("does not open a migration transaction for a current schema", async () => {
    let transactions = 0
    const driver: SqliteAgentStateDriver = {
      async execute(statement: string) {
        if (statement.includes("COALESCE(MAX(version)")) return { rows: [{ version: 5 }] }
        return { rows: [] }
      },
      async transaction(run) {
        transactions += 1
        return await run(driver)
      },
    }
    const adapter = new ViteHubSqliteAgentStateAdapter({ driver })

    await adapter.connect()
    expect(transactions).toBe(0)
    await adapter.disconnect()
  })

  it("awaits in-flight setup after the driver connects", async () => {
    let finishMigration: (() => void) | undefined
    let startMigration!: () => void
    const migrationStarted = new Promise<void>((resolve) => {
      startMigration = resolve
    })
    const driver: SqliteAgentStateDriver = {
      async execute(statement: string) {
        if (statement.includes("COALESCE(MAX(version)")) return { rows: [{ version: 2 }] }
        return { rows: [] }
      },
      async transaction(run) {
        startMigration()
        await new Promise<void>((finish) => {
          finishMigration = finish
        })
        return await run(driver)
      },
    }
    const adapter = new ViteHubSqliteAgentStateAdapter({ driver })
    const firstConnect = adapter.connect()

    await migrationStarted
    const secondConnect = adapter.connect()
    let secondResolved = false
    void secondConnect.then(() => {
      secondResolved = true
    })
    await Promise.resolve()
    expect(secondResolved).toBe(false)

    finishMigration?.()
    await expect(Promise.all([firstConnect, secondConnect])).resolves.toEqual([undefined, undefined])
    await adapter.disconnect()
  })

  it("creates parent directories for local libSQL file URLs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vitehub-agent-state-"))
    tempDirs.push(dir)
    const state = createLibsqlAgentState({ url: `file:${join(dir, "nested", "state.db")}` })

    await state.connect()
    await state.set("seen", "yes")
    await expect(state.get("seen")).resolves.toBe("yes")
    await state.disconnect()
  })

  it("validates generated table names before opening the database", () => {
    expect(() =>
      createSqliteAgentState({
        driver: { execute: async () => ({ rows: [] }) },
        tablePrefix: "bad-prefix-",
      }),
    ).toThrow("Invalid SQLite Agent State table name")
  })

  it("supports injected SQLite-compatible drivers", async () => {
    const executed: string[] = []
    const adapter = new ViteHubSqliteAgentStateAdapter({
      driver: {
        async execute(statement) {
          executed.push(statement)
          if (statement.includes("COALESCE(MAX(version)")) return { rows: [{ version: 2 }] }
          return { rows: [] }
        },
        async transaction(run) {
          return await run(this)
        },
      },
    })

    await adapter.connect()
    expect(executed.some((statement) => statement.includes("CREATE TABLE IF NOT EXISTS"))).toBe(true)
  })
})
