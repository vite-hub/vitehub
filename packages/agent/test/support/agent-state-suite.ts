import { afterEach, describe, expect, it, vi } from "vitest"

import type { QueueEntry } from "chat"
import type { AgentWebhookQueueDelivery } from "../../src/internal/webhook-queue.ts"
import type { SqliteAgentStateOptions, SqliteAgentStateRow, ViteHubSqliteAgentStateAdapter } from "../../src/state/sqlite.ts"

export interface AgentStateFixture {
  state: ViteHubSqliteAgentStateAdapter
  sql(statement: string, args?: unknown[]): Promise<SqliteAgentStateRow[]>
  reopen(options?: Pick<SqliteAgentStateOptions, "transcripts">): ViteHubSqliteAgentStateAdapter
  failInserts(table: string, message: string): Promise<() => Promise<void>>
}

export interface AgentStateStore {
  name: string
  fakeTimers?: Parameters<typeof vi.useFakeTimers>[0]
  create(tablePrefix?: string): Promise<AgentStateFixture>
  cleanup(): Promise<void>
}

export function queueEntry(text = "hello"): QueueEntry {
  return {
    enqueuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
    message: {
      author: { fullName: "User", isBot: false, isMe: false, userId: "u", userName: "user" },
      formatted: { children: [], type: "root" },
      id: "m",
      raw: {},
      text,
      threadId: "thread",
    } as never,
  }
}

export function webhookDelivery(deliveryId: string, concurrencyKey?: string, debounceKey?: string): AgentWebhookQueueDelivery {
  return {
    concurrencyGroup: "review",
    ...(concurrencyKey ? { concurrencyKey } : {}),
    concurrencyLimit: 2,
    deliveryId,
    enqueuedAt: Date.now(),
    ...(debounceKey ? { debounceKey } : {}),
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

export function describeAgentStateBehavior(store: AgentStateStore): void {
  const fakeClock = () => vi.useFakeTimers(store.fakeTimers)

  describe(`Agent State behavior on ${store.name}`, () => {
    afterEach(async () => {
      vi.useRealTimers()
      await store.cleanup()
    })

    it("preserves existing expired transcripts before cleanup and ignores new transcript TTLs", async () => {
      const { reopen, sql, state } = await store.create()
      await state.connect()
      const keys = ["transcripts:user:alice", "chat:bot:transcripts:user:bob"]
      for (const key of keys) await state.appendToList(key, "old", { ttlMs: 60_000 })
      await state.appendToList("other-list", "expired", { ttlMs: 60_000 })
      await state.disconnect()
      await sql("UPDATE test_agent_state_lists SET expires_at = 1")

      const retained = reopen({ transcripts: { retention: "forever" } })
      await retained.connect()
      for (const key of keys) {
        await expect(retained.getList(key)).resolves.toEqual(["old"])
        await retained.appendToList(key, "new", { ttlMs: 1 })
      }
      await expect(retained.getList("other-list")).resolves.toEqual([])
      expect((await sql("SELECT expires_at FROM test_agent_state_lists")).every(row => row.expires_at === null)).toBe(true)
      await retained.disconnect()
    })

    it("persists Chat SDK state", async () => {
      const { failInserts, reopen, state } = await store.create()
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

      const original = queueEntry("original")
      await state.enqueue("thread", original, 10)
      await state.enqueue("thread", queueEntry("tail"), 10)
      await expect(state.queuePeek("thread")).resolves.toEqual(original)
      const restoreInserts = await failInserts("test_agent_state_queue", "forced queue insert failure")
      await expect(state.queueReplaceHead("thread", original, [queueEntry("restored")], 10)).rejects.toThrow("forced queue insert failure")
      await expect(state.queuePeek("thread")).resolves.toEqual(original)
      await expect(state.queueDepth("thread")).resolves.toBe(2)
      await restoreInserts()
      await expect(state.queueReplaceHead("thread", original, [queueEntry("restored")], 10)).resolves.toBe(true)
      await expect(state.dequeue("thread")).resolves.toMatchObject({ message: { text: "restored" } })
      await expect(state.dequeue("thread")).resolves.toMatchObject({ message: { text: "tail" } })

      await state.subscribe("thread")
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

      const restored = reopen()
      await restored.connect()
      await expect(restored.get("seen")).resolves.toEqual({ id: 1 })
      await restored.disconnect()
    })

    it("leases webhook deliveries under global and per-key concurrency", async () => {
      const { sql, state: queue } = await store.create()
      await queue.connect()

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

      const expireLease = "UPDATE test_agent_state_webhook_queue SET lease_expires_at = 0 WHERE scope = ? AND delivery_id = ?"
      await sql(expireLease, [first!.scope, first!.deliveryId])
      await expect(queue.extendWebhookDeliveryLease(first!.scope, first!.deliveryId, "wrong-token", 30_000)).resolves.toBe(false)
      await expect(queue.extendWebhookDeliveryLease(first!.scope, first!.deliveryId, first!.leaseToken, 30_000)).resolves.toBe(true)
      await sql(expireLease, [first!.scope, first!.deliveryId])
      const competingDelivery = { ...webhookDelivery("delivery-competing", "pr-competing"), scope: "webhook:review:linear:" }
      await expect(queue.enqueueWebhookDelivery(competingDelivery)).resolves.toBe(true)
      const competingLease = await queue.claimWebhookDelivery(competingDelivery.scope)
      expect(competingLease?.deliveryId).toBe(competingDelivery.deliveryId)
      await expect(queue.extendWebhookDeliveryLease(first!.scope, first!.deliveryId, first!.leaseToken, 30_000)).resolves.toBe(false)
      await queue.completeWebhookDelivery(competingLease!.scope, competingLease!.deliveryId, competingLease!.leaseToken)
      await expect(queue.completeWebhookDelivery(first!.scope, first!.deliveryId, "wrong-token")).resolves.toBe(false)
      await expect(queue.completeWebhookDelivery(first!.scope, first!.deliveryId, first!.leaseToken)).resolves.toBe(true)
      await expect(sql("SELECT status, value FROM test_agent_state_webhook_queue WHERE scope = ? AND delivery_id = ?", [first!.scope, first!.deliveryId]))
        .resolves.toMatchObject([{ status: "completed", value: "{}" }])
      const third = await queue.claimWebhookDelivery("webhook:review:github:")
      expect(third?.deliveryId).toBe("delivery-2")

      await queue.completeWebhookDelivery(second!.scope, second!.deliveryId, second!.leaseToken)
      await queue.completeWebhookDelivery(third!.scope, third!.deliveryId, third!.leaseToken)
      await expect(queue.claimWebhookDelivery("webhook:review:github:")).resolves.toMatchObject({ deliveryId: "delivery-4" })
      await queue.disconnect()
    })

    it("removes expired rows before applying the queue limit", async () => {
      fakeClock()
      vi.setSystemTime(new Date("2026-08-04T09:00:00.000Z"))
      const { state } = await store.create()
      await state.connect()

      const expired = { ...queueEntry("expired"), expiresAt: Date.now() - 1 }
      await state.enqueue("thread", queueEntry("first"), 2)
      await state.enqueue("thread", expired, 2)
      await state.enqueue("thread", queueEntry("last"), 2)

      expect(await state.queueDepth("thread")).toBe(2)
      await expect(state.dequeue("thread")).resolves.toMatchObject({ message: { text: "first" } })
      await expect(state.dequeue("thread")).resolves.toMatchObject({ message: { text: "last" } })
      await expect(state.dequeue("thread")).resolves.toBeNull()
      await state.disconnect()
    })

    it("does not claim superseded debounced deliveries with concurrent capacity", async () => {
      const { state: queue } = await store.create()
      await queue.connect()
      await queue.enqueueWebhookDelivery(webhookDelivery("debounced-1", undefined, "pr-1"))
      await queue.enqueueWebhookDelivery(webhookDelivery("debounced-2", undefined, "pr-1"))

      await expect(queue.claimWebhookDelivery("webhook:review:github:")).resolves.toMatchObject({ deliveryId: "debounced-2" })
      await expect(queue.claimWebhookDelivery("webhook:review:github:")).resolves.toBeNull()
      await queue.disconnect()
    })

    it("preserves an active debounced delivery when a newer one is admitted", async () => {
      const { state: queue } = await store.create()
      await queue.connect()
      await queue.enqueueWebhookDelivery(webhookDelivery("debounced-running-1", undefined, "pr-2"))
      const first = await queue.claimWebhookDelivery("webhook:review:github:")
      expect(first?.deliveryId).toBe("debounced-running-1")
      await queue.enqueueWebhookDelivery(webhookDelivery("debounced-running-2", undefined, "pr-2"))
      await expect(queue.completeWebhookDelivery(first!.scope, first!.deliveryId, first!.leaseToken)).resolves.toBe(true)
      const second = await queue.claimWebhookDelivery("webhook:review:github:")
      expect(second?.deliveryId).toBe("debounced-running-2")
      await expect(queue.completeWebhookDelivery(second!.scope, second!.deliveryId, second!.leaseToken)).resolves.toBe(true)
      await expect(queue.claimWebhookDelivery("webhook:review:github:")).resolves.toBeNull()
      await queue.disconnect()
    })

    it("finalizes superseded debounced work after its lease expires", async () => {
      const { sql, state: queue } = await store.create()
      await queue.connect()
      await queue.enqueueWebhookDelivery(webhookDelivery("debounced-expired-1", undefined, "pr-expired"))
      const first = await queue.claimWebhookDelivery("webhook:review:github:")
      expect(first?.deliveryId).toBe("debounced-expired-1")
      await queue.enqueueWebhookDelivery(webhookDelivery("debounced-expired-2", undefined, "pr-expired"))
      await sql("UPDATE test_agent_state_webhook_queue SET lease_expires_at = 0 WHERE delivery_id = ?", [first!.deliveryId])

      await expect(queue.claimWebhookDelivery("webhook:review:github:")).resolves.toMatchObject({ deliveryId: "debounced-expired-2" })
      await expect(sql("SELECT status, value FROM test_agent_state_webhook_queue WHERE delivery_id = ?", [first!.deliveryId]))
        .resolves.toMatchObject([{ status: "completed", value: "{}" }])
      await queue.disconnect()
    })

    it("renews delayed steering ownership after its execution lease renews", async () => {
      const { sql, state: queue } = await store.create()
      await queue.connect()
      const execution = webhookDelivery("delivery-execution", "pr-1")
      const steering = webhookDelivery("delivery-steering", "pr-1")

      await queue.enqueueWebhookDelivery(execution)
      const executionLease = await queue.claimWebhookDelivery(execution.scope)
      expect(executionLease?.deliveryId).toBe(execution.deliveryId)
      await expect(queue.claimWebhookSteering(steering, "steering-token", Date.now() + 1_000)).resolves.toBe(true)

      await sql("UPDATE test_agent_state_webhook_queue SET lease_expires_at = 0 WHERE delivery_id IN (?, ?)", [execution.deliveryId, steering.deliveryId])
      await expect(queue.extendWebhookDeliveryLease(execution.scope, execution.deliveryId, executionLease!.leaseToken, 30_000)).resolves.toBe(true)
      await expect(queue.extendWebhookDeliveryLease(steering.scope, steering.deliveryId, "wrong-token", 30_000)).resolves.toBe(false)
      await expect(queue.extendWebhookDeliveryLease(steering.scope, steering.deliveryId, "steering-token", 30_000)).resolves.toBe(true)
      await queue.disconnect()
    })

    it("finds eligible webhook work beyond blocked keys in database order", async () => {
      fakeClock()
      vi.setSystemTime(new Date("2026-08-04T09:00:00.000Z"))
      const { state: queue } = await store.create()
      await queue.connect()

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
      await queue.disconnect()
    })

    it("reclaims expired webhook leases after reconnect and fences stale workers", async () => {
      fakeClock()
      vi.setSystemTime(new Date("2026-08-04T10:00:00.000Z"))
      const { reopen, state: queue } = await store.create()
      await queue.connect()
      await queue.enqueueWebhookDelivery(webhookDelivery("delivery-1"))
      const abandoned = await queue.claimWebhookDelivery("webhook:review:github:")
      await queue.disconnect()

      vi.advanceTimersByTime(1_001)
      const restored = reopen()
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

    it("keeps terminal notifications leased and recovers them after a worker exits", async () => {
      fakeClock()
      const { reopen, state: queue } = await store.create()
      await queue.connect()
      const delivery = webhookDelivery("pending-failure")
      await queue.enqueueWebhookDelivery(delivery)
      const lease = (await queue.claimWebhookDelivery(delivery.scope))!
      const failure = { error: "terminal failure", attempts: 3 }
      await expect(queue.markWebhookDeliveryFailure(lease.scope, lease.deliveryId, lease.leaseToken, failure)).resolves.toBe(true)
      await expect(queue.claimWebhookDelivery(delivery.scope)).resolves.toBeNull()
      await queue.disconnect()

      vi.advanceTimersByTime(1_001)
      const restored = reopen()
      await restored.connect()
      const recovered = (await restored.claimWebhookDelivery(delivery.scope))!
      expect(recovered.failure).toEqual(failure)
      expect(recovered.request).toEqual(delivery.request)
      await expect(restored.completeWebhookDelivery(lease.scope, lease.deliveryId, lease.leaseToken)).resolves.toBe(false)
      await expect(restored.completeWebhookDelivery(recovered.scope, recovered.deliveryId, recovered.leaseToken)).resolves.toBe(true)
      await expect(restored.claimWebhookDelivery(delivery.scope)).resolves.toBeNull()
      await restored.disconnect()
    })

    it("retains a durable notification claim across expiry and reconnect", async () => {
      fakeClock()
      const { reopen, state: queue } = await store.create()
      await queue.connect()
      const delivery = webhookDelivery("claimed-failure")
      await queue.enqueueWebhookDelivery(delivery)
      const original = (await queue.claimWebhookDelivery(delivery.scope))!
      await queue.markWebhookDeliveryFailure(original.scope, original.deliveryId, original.leaseToken, { error: "failed", attempts: 3 })
      vi.advanceTimersByTime(1_001)
      const recovered = (await queue.claimWebhookDelivery(delivery.scope))!
      await expect(queue.beginWebhookFailureNotification(original.scope, original.deliveryId, original.leaseToken)).resolves.toBe(false)
      await expect(queue.beginWebhookFailureNotification(recovered.scope, recovered.deliveryId, recovered.leaseToken)).resolves.toBe(true)
      await expect(queue.beginWebhookFailureNotification(recovered.scope, recovered.deliveryId, recovered.leaseToken)).resolves.toBe(false)
      await queue.disconnect()

      vi.advanceTimersByTime(60_000)
      const restored = reopen()
      await restored.connect()
      const finalizer = (await restored.claimWebhookDelivery(delivery.scope))!
      await expect(restored.beginWebhookFailureNotification(finalizer.scope, finalizer.deliveryId, finalizer.leaseToken)).resolves.toBe(false)
      await expect(restored.webhookDeliveries(delivery.scope)).resolves.toEqual([
        expect.objectContaining({ failure: { error: "failed", attempts: 3, notificationStarted: true } }),
      ])
      await expect(restored.completeWebhookDelivery(original.scope, original.deliveryId, original.leaseToken)).resolves.toBe(false)
      await expect(restored.completeWebhookDelivery(recovered.scope, recovered.deliveryId, recovered.leaseToken)).resolves.toBe(false)
      await expect(restored.completeWebhookDelivery(finalizer.scope, finalizer.deliveryId, finalizer.leaseToken)).resolves.toBe(true)
      await expect(restored.claimWebhookDelivery(delivery.scope)).resolves.toBeNull()
      await restored.disconnect()
    })

    it.each([false, true])("recovers finalization without a post-callback state write (missing expiry: %s)", async (missingExpiry) => {
      fakeClock()
      const { reopen, sql, state: queue } = await store.create()
      await queue.connect()
      const delivery = webhookDelivery("settled-failure")
      await queue.enqueueWebhookDelivery(delivery)
      const lease = (await queue.claimWebhookDelivery(delivery.scope))!
      await queue.markWebhookDeliveryFailure(lease.scope, lease.deliveryId, lease.leaseToken, { error: "failed", attempts: 3 })
      await queue.beginWebhookFailureNotification(lease.scope, lease.deliveryId, lease.leaseToken)
      if (missingExpiry) await sql("UPDATE test_agent_state_webhook_queue SET lease_expires_at = NULL WHERE status = 'notifying'")
      await queue.disconnect()

      vi.advanceTimersByTime(1_001)
      const restored = reopen()
      await restored.connect()
      const recovered = (await restored.claimWebhookDelivery(delivery.scope))!
      expect(recovered.failure).toEqual({ error: "failed", attempts: 3, notificationStarted: true })
      await expect(restored.beginWebhookFailureNotification(recovered.scope, recovered.deliveryId, recovered.leaseToken)).resolves.toBe(false)
      await expect(restored.completeWebhookDelivery(lease.scope, lease.deliveryId, lease.leaseToken)).resolves.toBe(false)
      await expect(restored.completeWebhookDelivery(recovered.scope, recovered.deliveryId, recovered.leaseToken)).resolves.toBe(true)
      await expect(restored.webhookDeliveries(delivery.scope)).resolves.toEqual([])
      await restored.disconnect()
    })

    it("completes terminal notifications with the original worker lease", async () => {
      const { state: queue } = await store.create()
      await queue.connect()
      const delivery = webhookDelivery("delivered-failure")
      await queue.enqueueWebhookDelivery(delivery)
      const lease = (await queue.claimWebhookDelivery(delivery.scope))!
      await queue.markWebhookDeliveryFailure(lease.scope, lease.deliveryId, lease.leaseToken, { error: "failed", attempts: 3 })
      await expect(queue.completeWebhookDelivery(lease.scope, lease.deliveryId, lease.leaseToken)).resolves.toBe(true)
      await expect(queue.claimWebhookDelivery(delivery.scope)).resolves.toBeNull()
      await queue.disconnect()
    })

    it("terminally completes an expired third webhook execution lease", async () => {
      fakeClock()
      vi.setSystemTime(new Date("2026-08-04T10:00:00.000Z"))
      const { reopen, state: queue } = await store.create()
      await queue.connect()
      await queue.enqueueWebhookDelivery(webhookDelivery("crashed-delivery"))
      let lease = await queue.claimWebhookDelivery("webhook:review:github:")
      await queue.retryWebhookDelivery(lease!.scope, lease!.deliveryId, lease!.leaseToken, Date.now())
      lease = await queue.claimWebhookDelivery("webhook:review:github:")
      await queue.retryWebhookDelivery(lease!.scope, lease!.deliveryId, lease!.leaseToken, Date.now())
      lease = await queue.claimWebhookDelivery("webhook:review:github:")
      await queue.disconnect()

      vi.advanceTimersByTime(1_001)
      const restored = reopen()
      await restored.connect()
      const terminal = await restored.claimWebhookDelivery("webhook:review:github:")
      expect(terminal?.attempts).toBe(3)
      await expect(restored.completeWebhookDelivery(terminal!.scope, terminal!.deliveryId, terminal!.leaseToken)).resolves.toBe(true)
      await expect(restored.enqueueWebhookDelivery(webhookDelivery("crashed-delivery"))).resolves.toBe(false)
      await restored.disconnect()
    })

    it("keeps accepted webhook steering durable until its invocation settles", async () => {
      fakeClock()
      vi.setSystemTime(new Date("2026-08-04T10:00:00.000Z"))
      const { state: queue } = await store.create()
      await queue.connect()
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
      await queue.disconnect()
    })

    it("fences same-key webhook claims after a timed-out invocation completes", async () => {
      fakeClock()
      vi.setSystemTime(new Date("2026-08-04T10:00:00.000Z"))
      const { state: queue } = await store.create()
      await queue.connect()
      const first = webhookDelivery("fenced-first", "same-key")
      await queue.enqueueWebhookDelivery(first)
      const lease = await queue.claimWebhookDelivery(first.scope)
      expect(lease).toBeDefined()
      const fence = await queue.acquireLock(`webhook-fence:${first.concurrencyKey}`, 1_000)
      expect(fence).toBeDefined()
      await queue.completeWebhookDelivery(lease!.scope, lease!.deliveryId, lease!.leaseToken)
      await queue.enqueueWebhookDelivery(webhookDelivery("fenced-second", "same-key"))
      await expect(queue.claimWebhookDelivery(first.scope)).resolves.toBeNull()
      await queue.releaseLock(fence!)
      await expect(queue.claimWebhookDelivery(first.scope)).resolves.toMatchObject({ deliveryId: "fenced-second" })
      await queue.disconnect()
    })

    it("does not steer ahead of older queued work for the same concurrency key", async () => {
      fakeClock()
      vi.setSystemTime(new Date("2026-08-04T10:00:00.000Z"))
      const { state: queue } = await store.create()
      await queue.connect()
      await queue.enqueueWebhookDelivery(webhookDelivery("queued-first", "pr-1"))
      vi.advanceTimersByTime(1)

      await expect(queue.claimWebhookSteering(webhookDelivery("steer-second", "pr-1"), "steer-token", Date.now() + 1_000)).resolves.toBe(false)
      await expect(queue.claimWebhookSteering(webhookDelivery("other-key", "pr-2"), "other-token", Date.now() + 1_000)).resolves.toBe(true)
      await queue.disconnect()
    })

    it("requires connect before using the state adapter", async () => {
      const { state } = await store.create()
      await expect(state.get("seen")).rejects.toThrow("not connected")
    })

    it("clears list expiry when appending without ttlMs", async () => {
      fakeClock()
      vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"))
      const { state } = await store.create()
      await state.connect()

      await state.appendToList("history", "one", { ttlMs: 100 })
      vi.setSystemTime(new Date("2026-06-02T10:00:00.050Z"))
      await state.appendToList("history", "two")
      vi.setSystemTime(new Date("2026-06-02T10:00:00.200Z"))

      await expect(state.getList("history")).resolves.toEqual(["one", "two"])
      await state.disconnect()
    })

    it("deletes cache and list rows for the same key", async () => {
      const { state } = await store.create()
      await state.connect()

      await state.set("thread", { seen: true })
      await state.appendToList("thread", "one")
      await state.delete("thread")

      await expect(state.get("thread")).resolves.toBeNull()
      await expect(state.getList("thread")).resolves.toEqual([])
      await state.disconnect()
    })

    it("expires cache entries and overwrites them in place", async () => {
      fakeClock()
      vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"))
      const { sql, state } = await store.create()
      await state.connect()

      await state.set("session", "first", 100)
      await state.set("session", "second", 100)
      await expect(state.get("session")).resolves.toBe("second")
      await expect(state.setIfNotExists("session", "third", 100)).resolves.toBe(false)
      expect(await sql("SELECT key FROM test_agent_state_cache")).toHaveLength(1)
      vi.setSystemTime(new Date("2026-06-02T10:00:00.100Z"))
      await expect(state.get("session")).resolves.toBeNull()
      await expect(state.setIfNotExists("session", "third", 100)).resolves.toBe(true)
      await expect(state.get("session")).resolves.toBe("third")
      await state.disconnect()
    })

    it("keeps a list until its newest entry expires and writes one row per append", async () => {
      fakeClock()
      vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"))
      const { sql, state } = await store.create()
      await state.connect()

      await state.appendToList("history", "one", { ttlMs: 100 })
      vi.setSystemTime(new Date("2026-06-02T10:00:00.080Z"))
      await state.appendToList("history", "two", { ttlMs: 100 })
      const expiry = (await sql("SELECT expires_at FROM test_agent_state_lists ORDER BY id")).map(row => Number(row.expires_at))
      expect(expiry).toEqual([Date.parse("2026-06-02T10:00:00.100Z"), Date.parse("2026-06-02T10:00:00.180Z")])

      vi.setSystemTime(new Date("2026-06-02T10:00:00.150Z"))
      await state.cleanupExpiredState()
      await expect(state.getList("history")).resolves.toEqual(["one", "two"])
      vi.setSystemTime(new Date("2026-06-02T10:00:00.180Z"))
      await expect(state.getList("history")).resolves.toEqual([])
      await state.disconnect()
    })

    it("trims a list to its newest entries", async () => {
      const { state } = await store.create()
      await state.connect()
      for (const value of ["one", "two", "three", "four"]) await state.appendToList("history", value, { maxLength: 2 })
      await expect(state.getList("history")).resolves.toEqual(["three", "four"])
      await state.disconnect()
    })

    it("does not restore expired list entries when appending", async () => {
      fakeClock()
      vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"))
      const { state } = await store.create()
      await state.connect()

      await state.appendToList("history", "expired", { ttlMs: 100 })
      vi.setSystemTime(new Date("2026-06-02T10:00:00.200Z"))
      await state.appendToList("history", "fresh")

      await expect(state.getList("history")).resolves.toEqual(["fresh"])
      await state.disconnect()
    })

    it("periodically removes expired durable rows", async () => {
      const tablePrefix = "cleanup_agent_state_"
      const { sql, state } = await store.create(tablePrefix)
      fakeClock()
      vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"))
      await state.connect()

      await state.set("expired-cache", "old", 100)
      await state.appendToList("expired-list", "old", { ttlMs: 100 })
      vi.setSystemTime(new Date("2026-06-02T10:06:00.000Z"))
      await state.set("fresh-cache", "new")

      expect((await sql(`SELECT key FROM ${tablePrefix}cache ORDER BY key`)).map(row => row.key)).toEqual(["fresh-cache"])
      expect(await sql(`SELECT key FROM ${tablePrefix}lists ORDER BY key`)).toEqual([])
      await state.disconnect()
    })
  })
}
