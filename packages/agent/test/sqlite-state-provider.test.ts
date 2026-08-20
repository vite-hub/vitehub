import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createLibsqlAgentState, createSqliteAgentState, type SqliteAgentStateDriver, ViteHubSqliteAgentStateAdapter } from "../src/state/sqlite.ts"

import type { QueueEntry, StateAdapter } from "chat"
import type { AgentWebhookQueueDelivery } from "../src/internal/webhook-queue.ts"

const tempDirs: string[] = []

async function createState(tablePrefix = "test_agent_state_"): Promise<{ state: StateAdapter, url: string }> {
  const dir = await mkdtemp(join(tmpdir(), "vitehub-agent-state-"))
  tempDirs.push(dir)
  const url = `file:${join(dir, "state.db")}`
  return {
    state: createLibsqlAgentState({ tablePrefix, url }),
    url,
  }
}

function queueEntry(text = "hello"): QueueEntry {
  return {
    enqueuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    message: { author: { fullName: "User", isBot: false, isMe: false, userId: "u", userName: "user" }, formatted: { children: [], type: "root" }, id: "m", raw: {}, text, threadId: "thread" } as never,
  }
}

function webhookDelivery(deliveryId: string, concurrencyKey?: string): AgentWebhookQueueDelivery {
  return {
    concurrencyGroup: "review",
    ...(concurrencyKey ? { concurrencyKey } : {}),
    concurrencyLimit: 2,
    deliveryId,
    enqueuedAt: Date.now(),
    leaseTtlMs: 1_000,
    request: {
      body: JSON.stringify({ action: "labeled" }),
      headers: { "content-type": "application/json" },
      method: "POST",
      url: "https://example.com/api/github",
    },
    scope: "webhook:review:github:",
    webhookId: "github",
  }
}

describe("SQLite Agent State Provider", () => {
  afterEach(async () => {
    vi.useRealTimers()
    await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
  })

  it("persists Chat SDK state in a libSQL-compatible SQLite database", async () => {
    const { state, url } = await createState()
    await state.connect()

    expect(await state.setIfNotExists("seen", { id: 1 })).toBe(true)
    expect(await state.setIfNotExists("seen", { id: 2 })).toBe(false)
    await expect(state.get("seen")).resolves.toEqual({ id: 1 })

    await state.appendToList("history", "one")
    await state.appendToList("history", "two", { maxLength: 1 })
    await expect(state.getList("history")).resolves.toEqual(["two"])
    await state.delete("history")
    await expect(state.getList("history")).resolves.toEqual([])

    await expect(state.enqueue("thread", queueEntry("one"), 10)).resolves.toBe(1)
    await expect(state.enqueue("thread", queueEntry("two"), 1)).resolves.toBe(1)
    await expect(state.queueDepth("thread")).resolves.toBe(1)
    await expect(state.dequeue("thread")).resolves.toMatchObject({ message: { text: "two" } })

    await state.subscribe("thread")
    await expect(state.isSubscribed("thread")).resolves.toBe(true)
    await state.unsubscribe("thread")
    await expect(state.isSubscribed("thread")).resolves.toBe(false)

    const lock = await state.acquireLock("thread", 30_000)
    expect(lock).toMatchObject({ threadId: "thread" })
    await expect(state.acquireLock("thread", 30_000)).resolves.toBeNull()
    await expect(state.extendLock(lock!, 30_000)).resolves.toBe(true)
    await state.releaseLock(lock!)
    await expect(state.acquireLock("thread", 30_000)).resolves.toMatchObject({ threadId: "thread" })
    await state.disconnect()

    const restored = createLibsqlAgentState({ tablePrefix: "test_agent_state_", url })
    await restored.connect()
    await expect(restored.get("seen")).resolves.toEqual({ id: 1 })
    await restored.disconnect()
  })

  it("leases webhook deliveries under global and per-key concurrency", async () => {
    const { state, url } = await createState()
    await state.connect()
    const queue = state as ViteHubSqliteAgentStateAdapter

    await expect(queue.enqueueWebhookDelivery(webhookDelivery("delivery-1", "pr-1"))).resolves.toBe(true)
    await expect(queue.enqueueWebhookDelivery(webhookDelivery("delivery-1", "pr-1"))).resolves.toBe(false)
    await expect(queue.enqueueWebhookDelivery(webhookDelivery("delivery-2", "pr-1"))).resolves.toBe(true)
    await expect(queue.enqueueWebhookDelivery(webhookDelivery("delivery-3", "pr-2"))).resolves.toBe(true)
    await expect(queue.enqueueWebhookDelivery(webhookDelivery("delivery-4", "pr-3"))).resolves.toBe(true)
    await expect(queue.webhookDeliveryScopes()).resolves.toEqual(["webhook:review:github:"])

    const first = await queue.claimWebhookDelivery("webhook:review:github:")
    const second = await queue.claimWebhookDelivery("webhook:review:github:")
    expect(first?.deliveryId).toBe("delivery-1")
    expect(second?.deliveryId).toBe("delivery-3")
    await expect(queue.claimWebhookDelivery("webhook:review:github:")).resolves.toBeNull()

    const client = createClient({ url })
    await client.execute({
      args: [first!.scope, first!.deliveryId],
      sql: "UPDATE test_agent_state_webhook_queue SET lease_expires_at = 0 WHERE scope = ? AND delivery_id = ?",
    })
    await expect(queue.extendWebhookDeliveryLease(first!.scope, first!.deliveryId, "wrong-token", 30_000)).resolves.toBe(false)
    await expect(queue.extendWebhookDeliveryLease(first!.scope, first!.deliveryId, first!.leaseToken, 30_000)).resolves.toBe(true)
    await client.execute({
      args: [first!.scope, first!.deliveryId],
      sql: "UPDATE test_agent_state_webhook_queue SET lease_expires_at = 0 WHERE scope = ? AND delivery_id = ?",
    })
    const competingDelivery = { ...webhookDelivery("delivery-competing", "pr-competing"), scope: "webhook:review:linear:" }
    await expect(queue.enqueueWebhookDelivery(competingDelivery)).resolves.toBe(true)
    const competingLease = await queue.claimWebhookDelivery(competingDelivery.scope)
    expect(competingLease?.deliveryId).toBe(competingDelivery.deliveryId)
    await expect(queue.extendWebhookDeliveryLease(first!.scope, first!.deliveryId, first!.leaseToken, 30_000)).resolves.toBe(false)
    await queue.completeWebhookDelivery(competingLease!.scope, competingLease!.deliveryId, competingLease!.leaseToken)
    await expect(queue.completeWebhookDelivery(first!.scope, first!.deliveryId, "wrong-token")).resolves.toBe(false)
    await expect(queue.completeWebhookDelivery(first!.scope, first!.deliveryId, first!.leaseToken)).resolves.toBe(true)
    await expect(client.execute({
      args: [first!.scope, first!.deliveryId],
      sql: "SELECT status, value FROM test_agent_state_webhook_queue WHERE scope = ? AND delivery_id = ?",
    })).resolves.toMatchObject({ rows: [{ status: "completed", value: "{}" }] })
    client.close()
    const third = await queue.claimWebhookDelivery("webhook:review:github:")
    expect(third?.deliveryId).toBe("delivery-2")

    await queue.completeWebhookDelivery(second!.scope, second!.deliveryId, second!.leaseToken)
    await queue.completeWebhookDelivery(third!.scope, third!.deliveryId, third!.leaseToken)
    await expect(queue.claimWebhookDelivery("webhook:review:github:")).resolves.toMatchObject({ deliveryId: "delivery-4" })
    await state.disconnect()
  })

  it("renews delayed steering ownership after its execution lease renews", async () => {
    const { state, url } = await createState()
    await state.connect()
    const queue = state as ViteHubSqliteAgentStateAdapter
    const execution = webhookDelivery("delivery-execution", "pr-1")
    const steering = webhookDelivery("delivery-steering", "pr-1")

    await queue.enqueueWebhookDelivery(execution)
    const executionLease = await queue.claimWebhookDelivery(execution.scope)
    expect(executionLease?.deliveryId).toBe(execution.deliveryId)
    await expect(queue.claimWebhookSteering(steering, "steering-token", Date.now() + 1_000)).resolves.toBe(true)

    const client = createClient({ url })
    await client.execute({
      args: [execution.deliveryId, steering.deliveryId],
      sql: "UPDATE test_agent_state_webhook_queue SET lease_expires_at = 0 WHERE delivery_id IN (?, ?)",
    })
    await expect(queue.extendWebhookDeliveryLease(execution.scope, execution.deliveryId, executionLease!.leaseToken, 30_000)).resolves.toBe(true)
    await expect(queue.extendWebhookDeliveryLease(steering.scope, steering.deliveryId, "wrong-token", 30_000)).resolves.toBe(false)
    await expect(queue.extendWebhookDeliveryLease(steering.scope, steering.deliveryId, "steering-token", 30_000)).resolves.toBe(true)

    client.close()
    await state.disconnect()
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
    const execute = vi.fn(async (statement: string, args?: unknown[]) => {
      if (busyLock && statement.includes("INSERT INTO test_agent_state_locks")) {
        busyLock = false
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
      }
      if (busySteering && statement.includes("INSERT OR IGNORE") && statement.includes("'steering'")) {
        busySteering = false
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
      }
      if (busyRelease && statement.includes("DELETE FROM test_agent_state_locks WHERE thread_id = ? AND token = ?")) {
        busyRelease = false
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
      }
      if (busyEnqueue && statement.includes("INSERT OR IGNORE INTO test_agent_state_webhook_queue")) {
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
      return await client.execute({ args: (args || []) as never, sql: statement })
    })
    const contended = createSqliteAgentState({
      driver: {
        connect: async () => undefined,
        execute,
      },
      tablePrefix: "test_agent_state_",
    })
    await contended.connect()
    expect(execute.mock.calls.some(([statement]) => statement.includes("_active_scope"))).toBe(true)
    const contendedLock = await contended.acquireLock("contended", 1_000)
    expect(contendedLock).toMatchObject({ threadId: "contended" })
    expect(execute.mock.calls.filter(([statement]) => String(statement).includes("INSERT INTO test_agent_state_locks"))).toHaveLength(2)
    await expect(contended.releaseLock(contendedLock!)).resolves.toBeUndefined()
    expect(execute.mock.calls.filter(([statement]) => String(statement).includes("DELETE FROM test_agent_state_locks WHERE thread_id = ? AND token = ?"))).toHaveLength(2)

    ;(contended as unknown as { nextCleanupAt: number }).nextCleanupAt = 0
    busyCleanup = true
    await expect(contended.enqueueWebhookDelivery(webhookDelivery("delivery-busy"))).resolves.toBe(true)
    expect(execute.mock.calls.filter(([statement]) => String(statement).includes("INSERT OR IGNORE INTO test_agent_state_webhook_queue"))).toHaveLength(2)
    const lease = await contended.claimWebhookDelivery("webhook:review:github:")
    ;(contended as unknown as { nextCleanupAt: number }).nextCleanupAt = 0
    busyCleanup = true
    await expect(contended.completeWebhookDelivery(lease!.scope, lease!.deliveryId, lease!.leaseToken)).resolves.toBe(true)
    expect(execute.mock.calls.filter(([statement]) => String(statement).includes("SET status = 'completed'"))).toHaveLength(2)
    await expect(contended.enqueueWebhookDelivery(webhookDelivery("delivery-retry-busy"))).resolves.toBe(true)
    const retryLease = await contended.claimWebhookDelivery("webhook:review:github:")
    ;(contended as unknown as { nextCleanupAt: number }).nextCleanupAt = 0
    busyCleanup = true
    await expect(contended.retryWebhookDelivery(retryLease!.scope, retryLease!.deliveryId, retryLease!.leaseToken, Date.now())).resolves.toBe(true)
    expect(execute.mock.calls.filter(([statement]) => String(statement).includes("SET status = 'queued'"))).toHaveLength(2)
    expect(execute.mock.calls.filter(([statement]) => String(statement).includes("DELETE FROM test_agent_state_locks"))).toHaveLength(11)
    ;(contended as unknown as { nextCleanupAt: number }).nextCleanupAt = 0
    busyCleanup = true
    await expect(contended.claimWebhookSteering(webhookDelivery("steering-busy"), "steer-token", Date.now() + 1_000)).resolves.toBe(true)
    expect(execute.mock.calls.filter(([statement]) => String(statement).includes("INSERT OR IGNORE") && String(statement).includes("'steering'"))).toHaveLength(2)
    client.close()
  })

  it("finds eligible webhook work beyond blocked keys in database order", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-04T09:00:00.000Z"))
    const { state } = await createState()
    await state.connect()
    const queue = state as ViteHubSqliteAgentStateAdapter

    await queue.enqueueWebhookDelivery(webhookDelivery("blocker", "shared"))
    const blocker = await queue.claimWebhookDelivery("webhook:review:github:")
    expect(blocker?.deliveryId).toBe("blocker")
    for (let index = 0; index < 101; index += 1) {
      await queue.enqueueWebhookDelivery(webhookDelivery(`blocked-${index}`, "shared"))
    }
    await queue.enqueueWebhookDelivery(webhookDelivery("eligible", "other"))

    const eligible = await queue.claimWebhookDelivery("webhook:review:github:")
    expect(eligible?.deliveryId).toBe("eligible")
    await queue.completeWebhookDelivery(blocker!.scope, blocker!.deliveryId, blocker!.leaseToken)
    await queue.completeWebhookDelivery(eligible!.scope, eligible!.deliveryId, eligible!.leaseToken)
    await expect(queue.claimWebhookDelivery("webhook:review:github:")).resolves.toMatchObject({ deliveryId: "blocked-0" })
    await state.disconnect()
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

  it("reclaims expired webhook leases after reconnect and fences stale workers", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-04T10:00:00.000Z"))
    const { state, url } = await createState()
    await state.connect()
    const queue = state as ViteHubSqliteAgentStateAdapter
    await queue.enqueueWebhookDelivery(webhookDelivery("delivery-1"))
    const abandoned = await queue.claimWebhookDelivery("webhook:review:github:")
    await state.disconnect()

    vi.advanceTimersByTime(1_001)
    const restored = createLibsqlAgentState({ tablePrefix: "test_agent_state_", url })
    await restored.connect()
    const reclaimed = await restored.claimWebhookDelivery("webhook:review:github:")
    expect(reclaimed?.deliveryId).toBe("delivery-1")
    expect(reclaimed?.leaseToken).not.toBe(abandoned?.leaseToken)
    expect(reclaimed?.attempts).toBe(1)
    await expect(restored.completeWebhookDelivery(reclaimed!.scope, reclaimed!.deliveryId, abandoned!.leaseToken)).resolves.toBe(false)
    await expect(restored.completeWebhookDelivery(reclaimed!.scope, reclaimed!.deliveryId, reclaimed!.leaseToken)).resolves.toBe(true)
    await expect(restored.enqueueWebhookDelivery(webhookDelivery("delivery-1"))).resolves.toBe(false)
    await restored.disconnect()
  })

  it("terminally completes an expired third webhook execution lease", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-04T10:00:00.000Z"))
    const { state, url } = await createState()
    await state.connect()
    const queue = state as ViteHubSqliteAgentStateAdapter
    await queue.enqueueWebhookDelivery(webhookDelivery("crashed-delivery"))
    let lease = await queue.claimWebhookDelivery("webhook:review:github:")
    await queue.retryWebhookDelivery(lease!.scope, lease!.deliveryId, lease!.leaseToken, Date.now())
    lease = await queue.claimWebhookDelivery("webhook:review:github:")
    await queue.retryWebhookDelivery(lease!.scope, lease!.deliveryId, lease!.leaseToken, Date.now())
    lease = await queue.claimWebhookDelivery("webhook:review:github:")
    await state.disconnect()

    vi.advanceTimersByTime(1_001)
    const restored = createLibsqlAgentState({ tablePrefix: "test_agent_state_", url })
    await restored.connect()
    const terminal = await restored.claimWebhookDelivery("webhook:review:github:")
    expect(terminal?.attempts).toBe(3)
    await expect(restored.completeWebhookDelivery(terminal!.scope, terminal!.deliveryId, terminal!.leaseToken)).resolves.toBe(true)
    await expect(restored.enqueueWebhookDelivery(webhookDelivery("crashed-delivery"))).resolves.toBe(false)
    await restored.disconnect()
  })

  it("keeps accepted webhook steering durable until its invocation settles", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-04T10:00:00.000Z"))
    const { state } = await createState()
    await state.connect()
    const queue = state as ViteHubSqliteAgentStateAdapter
    const delivery = webhookDelivery("steered-delivery")

    await expect(queue.claimWebhookSteering(delivery, "steer-token", Date.now() + 1_000)).resolves.toBe(true)
    await expect(queue.enqueueWebhookDelivery(delivery)).resolves.toBe(false)
    await queue.enqueueWebhookDelivery(webhookDelivery("unrelated-1", "pr-1"))
    await queue.enqueueWebhookDelivery(webhookDelivery("unrelated-2", "pr-2"))
    const unrelated1 = await queue.claimWebhookDelivery(delivery.scope)
    const unrelated2 = await queue.claimWebhookDelivery(delivery.scope)
    expect(unrelated1?.deliveryId).toBe("unrelated-1")
    expect(unrelated2?.deliveryId).toBe("unrelated-2")
    await expect(queue.claimWebhookDelivery(delivery.scope)).resolves.toBeNull()
    await queue.completeWebhookDelivery(unrelated1!.scope, unrelated1!.deliveryId, unrelated1!.leaseToken)
    await queue.completeWebhookDelivery(unrelated2!.scope, unrelated2!.deliveryId, unrelated2!.leaseToken)

    vi.advanceTimersByTime(1_001)
    const recovered = await queue.claimWebhookDelivery(delivery.scope)
    expect(recovered?.deliveryId).toBe(delivery.deliveryId)
    expect(recovered?.leaseToken).not.toBe("steer-token")
    expect(recovered?.attempts).toBe(1)
    await state.disconnect()
  })

  it("does not steer ahead of older queued work for the same concurrency key", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-04T10:00:00.000Z"))
    const { state } = await createState()
    await state.connect()
    const queue = state as ViteHubSqliteAgentStateAdapter
    await queue.enqueueWebhookDelivery(webhookDelivery("queued-first", "pr-1"))
    vi.advanceTimersByTime(1)

    await expect(queue.claimWebhookSteering(
      webhookDelivery("steer-second", "pr-1"),
      "steer-token",
      Date.now() + 1_000,
    )).resolves.toBe(false)
    await expect(queue.claimWebhookSteering(
      webhookDelivery("other-key", "pr-2"),
      "other-token",
      Date.now() + 1_000,
    )).resolves.toBe(true)
    await state.disconnect()
  })

  it("requires connect before using the state adapter", async () => {
    const { state } = await createState()
    await expect(state.get("seen")).rejects.toThrow("not connected")
  })

  it("requires custom libSQL clients to support transactions", async () => {
    const state = createLibsqlAgentState({
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
          await new Promise(resolve => setTimeout(resolve, 10))
          return await run(driver)
        }
        finally {
          inTransaction = false
        }
      },
    }
    const adapter = new ViteHubSqliteAgentStateAdapter({ driver })

    await expect(Promise.all([adapter.connect(), adapter.connect()])).resolves.toEqual([undefined, undefined])
    expect(migrations).toBe(1)
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

  it("clears list expiry when appending without ttlMs", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"))
    const { state } = await createState()
    await state.connect()

    await state.appendToList("history", "one", { ttlMs: 100 })
    vi.setSystemTime(new Date("2026-06-02T10:00:00.050Z"))
    await state.appendToList("history", "two")
    vi.setSystemTime(new Date("2026-06-02T10:00:00.200Z"))

    await expect(state.getList("history")).resolves.toEqual(["one", "two"])
    await state.disconnect()
  })

  it("deletes cache and list rows for the same key", async () => {
    const { state } = await createState()
    await state.connect()

    await state.set("thread", { seen: true })
    await state.appendToList("thread", "one")
    await state.delete("thread")

    await expect(state.get("thread")).resolves.toBeNull()
    await expect(state.getList("thread")).resolves.toEqual([])
    await state.disconnect()
  })

  it("does not restore expired list entries when appending", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"))
    const { state } = await createState()
    await state.connect()

    await state.appendToList("history", "expired", { ttlMs: 100 })
    vi.setSystemTime(new Date("2026-06-02T10:00:00.200Z"))
    await state.appendToList("history", "fresh")

    await expect(state.getList("history")).resolves.toEqual(["fresh"])
    await state.disconnect()
  })

  it("periodically removes expired durable rows", async () => {
    const tablePrefix = "cleanup_agent_state_"
    const { state, url } = await createState(tablePrefix)
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"))
    await state.connect()

    await state.set("expired-cache", "old", 100)
    await state.appendToList("expired-list", "old", { ttlMs: 100 })
    vi.setSystemTime(new Date("2026-06-02T10:06:00.000Z"))
    await state.set("fresh-cache", "new")

    const client = createClient({ url })
    const cacheRows = await client.execute(`SELECT key FROM ${tablePrefix}cache ORDER BY key`)
    const listRows = await client.execute(`SELECT key FROM ${tablePrefix}lists ORDER BY key`)
    client.close()

    expect(cacheRows.rows.map(row => row.key)).toEqual(["fresh-cache"])
    expect(listRows.rows).toEqual([])
    await state.disconnect()
  })

  it("validates generated table names before opening the database", () => {
    expect(() => createSqliteAgentState({
      driver: { execute: async () => ({ rows: [] }) },
      tablePrefix: "bad-prefix-",
    })).toThrow("Invalid SQLite Agent State table name")
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
    expect(executed.some(statement => statement.includes("CREATE TABLE IF NOT EXISTS"))).toBe(true)
  })
})
