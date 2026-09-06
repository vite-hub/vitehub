import { afterEach, describe, expect, it, vi } from "vitest"

import type { AtomicAgentStateQueueAdapter } from "../src/internal/state-queue.ts"
import { isRuntimeNumber } from "../src/internal/runtime-value.ts"
import { createCloudflareAgentState } from "../src/state/providers/cloudflare.ts"

import type { Lock, QueueEntry } from "chat"
import type { ViteHubAgentStateDurableObjectNamespace, ViteHubAgentStateDurableObjectStub } from "../src/state/providers/cloudflare.ts"

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown

    constructor(ctx: unknown) {
      this.ctx = ctx
    }
  },
}))

interface FakeSqlCursor {
  one(): Record<string, unknown>
  toArray(): Array<Record<string, unknown>>
}

interface FakeListRow {
  expires_at: number | null
  id: number
  key: string
  value: string
}

interface FakeQueueRow {
  expires_at: number
  id: number
  thread_id: string
  value: string
}

function sqlCursor(rows: Array<Record<string, unknown>> = []): FakeSqlCursor {
  return {
    one: () => rows[0] || {},
    toArray: () => rows,
  }
}

function queueEntry(text: string): QueueEntry {
  return {
    enqueuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
    message: {
      author: { fullName: "User", isBot: false, isMe: false, userId: "u", userName: "user" },
      formatted: { children: [], type: "root" },
      id: text,
      raw: {},
      text,
      threadId: "thread",
    } as never,
  }
}

function createFakeDurableObjectState() {
  const lists: FakeListRow[] = []
  const queues: FakeQueueRow[] = []
  let nextId = 0
  const sql = {
    exec(query: string, ...bindings: unknown[]): FakeSqlCursor {
      const normalized = query.replace(/\s+/g, " ").trim()
      if (normalized.startsWith("CREATE ") || normalized.startsWith("CREATE INDEX ")) return sqlCursor()
      if (normalized.startsWith("INSERT INTO _schema_version")) return sqlCursor()
      if (normalized.startsWith("SELECT COALESCE(MAX(version)")) return sqlCursor([{ version: 2 }])
      if (normalized.startsWith("INSERT INTO lists")) {
        const [key, value, expiresAt] = bindings
        // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
        lists.push({ expires_at: expiresAt as number | null, id: ++nextId, key: String(key), value: String(value) })
        return sqlCursor()
      }
      if (normalized.startsWith("UPDATE lists SET expires_at = ? WHERE key = ?")) {
        const [expiresAt, key] = bindings
        for (const row of lists) {
          // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
          if (row.key === key) row.expires_at = expiresAt as number | null
        }
        return sqlCursor()
      }
      if (normalized.startsWith("DELETE FROM lists WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?")) {
        const [key, now] = bindings
        for (let index = lists.length - 1; index >= 0; index--) {
          const expiresAt = lists[index]!.expires_at
          if (lists[index]!.key === key && expiresAt !== null && expiresAt <= Number(now)) lists.splice(index, 1)
        }
        return sqlCursor()
      }
      if (normalized.startsWith("DELETE FROM lists WHERE key = ? AND id NOT IN")) {
        const [key, , maxLength] = bindings
        const keepIds = new Set(
          lists
            .filter((row) => row.key === key)
            .sort((a, b) => b.id - a.id)
            .slice(0, Number(maxLength))
            .map((row) => row.id),
        )
        for (let index = lists.length - 1; index >= 0; index--) {
          if (lists[index]!.key === key && !keepIds.has(lists[index]!.id)) lists.splice(index, 1)
        }
        return sqlCursor()
      }
      if (normalized.startsWith("SELECT value FROM lists WHERE key = ? ORDER BY id ASC")) {
        const [key] = bindings
        return sqlCursor(
          lists
            .filter((row) => row.key === key)
            .sort((a, b) => a.id - b.id)
            .map((row) => ({ value: row.value })),
        )
      }
      if (normalized.startsWith("SELECT MIN(expires_at) as next_expiry")) {
        const now = Number(bindings[0] || Date.now())
        const next =
          lists
            .map((row) => row.expires_at)
            .filter((expiresAt): expiresAt is number => isRuntimeNumber(expiresAt) && expiresAt > now)
            .sort((a, b) => a - b)[0] ?? null
        return sqlCursor([{ next_expiry: next }])
      }
      if (normalized.startsWith("DELETE FROM queue WHERE thread_id = ? AND expires_at <= ?")) {
        const [threadId, now] = bindings
        for (let index = queues.length - 1; index >= 0; index--) {
          if (queues[index]!.thread_id === threadId && queues[index]!.expires_at <= Number(now)) queues.splice(index, 1)
        }
        return sqlCursor()
      }
      if (normalized.startsWith("SELECT value FROM queue WHERE thread_id = ? ORDER BY id ASC")) {
        const [threadId] = bindings
        const matches = queues.filter((row) => row.thread_id === threadId).sort((a, b) => a.id - b.id)
        const selected = normalized.endsWith("LIMIT 1") ? matches.slice(0, 1) : matches
        return sqlCursor(selected.map((row) => ({ value: row.value })))
      }
      if (normalized.startsWith("SELECT id, value FROM queue WHERE thread_id = ? ORDER BY id ASC LIMIT 1")) {
        const [threadId] = bindings
        return sqlCursor(
          queues
            .filter((row) => row.thread_id === threadId)
            .sort((a, b) => a.id - b.id)
            .slice(0, 1)
            .map((row) => ({ ...row })),
        )
      }
      if (normalized.startsWith("DELETE FROM queue WHERE thread_id = ?")) {
        const [threadId] = bindings
        for (let index = queues.length - 1; index >= 0; index--) {
          if (queues[index]!.thread_id === threadId) queues.splice(index, 1)
        }
        return sqlCursor()
      }
      if (normalized.startsWith("DELETE FROM queue WHERE id = ?")) {
        const [id] = bindings
        const index = queues.findIndex((row) => row.id === id)
        if (index >= 0) queues.splice(index, 1)
        return sqlCursor()
      }
      if (normalized.startsWith("INSERT INTO queue")) {
        const [threadId, value, , expiresAt] = bindings
        queues.push({ expires_at: Number(expiresAt), id: ++nextId, thread_id: String(threadId), value: String(value) })
        return sqlCursor()
      }
      throw new Error(`Unhandled fake SQL query: ${normalized}`)
    },
  }
  const storage = {
    setAlarm: vi.fn(async () => {}),
    sql,
    transactionSync<T>(callback: () => T): T {
      return callback()
    },
  }
  return {
    ctx: {
      blockConcurrencyWhile(callback: () => Promise<void>) {
        void callback()
      },
      storage,
    },
    lists,
  }
}

function createFakeCloudflareStateNamespace(): ViteHubAgentStateDurableObjectNamespace {
  const values = new Map<string, string>()
  const lists = new Map<string, string[]>()
  const subscriptions = new Set<string>()
  const queues = new Map<string, string[]>()
  const locks = new Map<string, Lock>()
  const stub: ViteHubAgentStateDurableObjectStub = {
    acquireLock(threadId, ttlMs) {
      const current = locks.get(threadId)
      if (current && current.expiresAt > Date.now()) return null
      const lock = { expiresAt: Date.now() + ttlMs, threadId, token: `lock-${threadId}` }
      locks.set(threadId, lock)
      return lock
    },
    cacheDelete(key) {
      values.delete(key)
      lists.delete(key)
    },
    cacheGet(key) {
      return values.get(key) || null
    },
    cacheSet(key, value) {
      values.set(key, value)
    },
    cacheSetIfNotExists(key, value) {
      if (values.has(key)) return false
      values.set(key, value)
      return true
    },
    dequeue(threadId) {
      const queue = queues.get(threadId) || []
      const entry = queue.shift()
      if (queue.length) queues.set(threadId, queue)
      else queues.delete(threadId)
      return entry || null
    },
    enqueue(threadId, value, maxSize) {
      const queue = queues.get(threadId) || []
      queue.push(value)
      queues.set(threadId, queue.slice(-maxSize))
      return queues.get(threadId)!.length
    },
    extendLock(threadId, token, ttlMs) {
      const current = locks.get(threadId)
      if (current?.token !== token) return false
      current.expiresAt = Date.now() + ttlMs
      return true
    },
    forceReleaseLock(threadId) {
      locks.delete(threadId)
    },
    isSubscribed(threadId) {
      return subscriptions.has(threadId)
    },
    listAppend(key, value, maxLength) {
      const next = [...(lists.get(key) || []), value]
      lists.set(key, isRuntimeNumber(maxLength) ? next.slice(-maxLength) : next)
    },
    listGet(key) {
      return lists.get(key) || []
    },
    queueDepth(threadId) {
      return queues.get(threadId)?.length || 0
    },
    queuePeek(threadId) {
      return queues.get(threadId)?.[0] || null
    },
    queueReplaceHead(threadId, expected, replacement, maxSize) {
      const queue = queues.get(threadId) || []
      if ((queue[0] || null) !== expected) return false
      const next = [...replacement, ...queue.slice(expected === null ? 0 : 1)].slice(-maxSize)
      if (next.length) queues.set(threadId, next)
      else queues.delete(threadId)
      return true
    },
    releaseLock(threadId, token) {
      if (locks.get(threadId)?.token === token) locks.delete(threadId)
    },
    subscribe(threadId) {
      subscriptions.add(threadId)
    },
    unsubscribe(threadId) {
      subscriptions.delete(threadId)
    },
  }

  return {
    get() {
      return stub
    },
    idFromName(name: string) {
      return name
    },
  }
}

describe("Cloudflare Agent State Provider", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("adapts a Durable Object namespace to Chat SDK state", async () => {
    const state = createCloudflareAgentState({ namespace: createFakeCloudflareStateNamespace() })
    await state.connect()

    expect(await state.setIfNotExists("seen", { id: 1 })).toBe(true)
    expect(await state.setIfNotExists("seen", { id: 2 })).toBe(false)
    await expect(state.get("seen")).resolves.toEqual({ id: 1 })

    await state.appendToList("history", "one")
    await state.appendToList("history", "two", { maxLength: 1 })
    await expect(state.getList("history")).resolves.toEqual(["two"])
    await state.delete("history")
    await expect(state.getList("history")).resolves.toEqual([])

    const entry: QueueEntry = {
      enqueuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
      message: {
        author: { fullName: "User", isBot: false, isMe: false, userId: "u", userName: "user" },
        formatted: { children: [], type: "root" },
        id: "m",
        raw: {},
        text: "hello",
        threadId: "thread",
      } as never,
    }
    await expect(state.enqueue("thread", entry, 10)).resolves.toBe(1)
    await expect(state.dequeue("thread")).resolves.toEqual(entry)

    // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
    const original = { ...entry, message: { ...entry.message, text: "original" } } as QueueEntry
    // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
    const tail = { ...entry, message: { ...entry.message, text: "tail" } } as QueueEntry
    // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
    const restored = { ...entry, message: { ...entry.message, text: "restored" } } as QueueEntry
    await state.enqueue("thread", original, 10)
    await state.enqueue("thread", tail, 10)
    // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
    const atomicQueue = state as AtomicAgentStateQueueAdapter
    await expect(atomicQueue.queuePeek("thread")).resolves.toEqual(original)
    await expect(atomicQueue.queueReplaceHead("thread", original, [restored], 10)).resolves.toBe(true)
    await expect(state.dequeue("thread")).resolves.toEqual(restored)
    await expect(state.dequeue("thread")).resolves.toEqual(tail)

    const lock = await state.acquireLock("thread", 30_000)
    expect(lock).toMatchObject({ threadId: "thread" })
    await expect(state.acquireLock("thread", 30_000)).resolves.toBeNull()
    await state.releaseLock(lock!)
    await expect(state.acquireLock("thread", 30_000)).resolves.toMatchObject({ threadId: "thread" })
  })

  it("requires connect before using the state adapter", async () => {
    const state = createCloudflareAgentState({ namespace: createFakeCloudflareStateNamespace() })
    await expect(state.get("seen")).rejects.toThrow("not connected")
  })

  it("clears list expiry when appending without ttlMs", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-31T10:00:00.000Z"))
    const { ViteHubAgentStateDO } = await import("../src/cloudflare/state.ts")
    const { ctx } = createFakeDurableObjectState()
    // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
    const state = new ViteHubAgentStateDO(ctx as never, {})

    state.listAppend("history", "one", undefined, 100)
    vi.setSystemTime(new Date("2026-05-31T10:00:00.050Z"))
    state.listAppend("history", "two")
    vi.setSystemTime(new Date("2026-05-31T10:00:00.200Z"))

    expect(state.listGet("history")).toEqual(["one", "two"])
  })

  it("atomically replaces a durable queue head", async () => {
    const { ViteHubAgentStateDO } = await import("../src/cloudflare/state.ts")
    const { ctx } = createFakeDurableObjectState()
    // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
    const state = new ViteHubAgentStateDO(ctx as never, {})
    const original = JSON.stringify(queueEntry("original"))
    const tail = JSON.stringify(queueEntry("tail"))
    const restored = JSON.stringify(queueEntry("restored"))

    expect(state.queueReplaceHead("thread", null, [original, tail], 10)).toBe(true)
    expect(state.queuePeek("thread")).toBe(original)
    expect(state.queueReplaceHead("thread", tail, [restored], 10)).toBe(false)
    expect(state.queuePeek("thread")).toBe(original)
    expect(state.queueReplaceHead("thread", original, [restored], 10)).toBe(true)
    expect(state.dequeue("thread")).toBe(restored)
    expect(state.dequeue("thread")).toBe(tail)
  })
})
