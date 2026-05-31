import { describe, expect, it } from "vitest"

import { createCloudflareAgentState } from "../src/state/providers/cloudflare.ts"

import type { Lock, QueueEntry } from "chat"
import type { ViteHubAgentStateDurableObjectNamespace, ViteHubAgentStateDurableObjectStub } from "../src/state/providers/cloudflare.ts"

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
      lists.set(key, typeof maxLength === "number" ? next.slice(-maxLength) : next)
    },
    listGet(key) {
      return lists.get(key) || []
    },
    queueDepth(threadId) {
      return queues.get(threadId)?.length || 0
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
      message: { author: { fullName: "User", isBot: false, isMe: false, userId: "u", userName: "user" }, formatted: { children: [], type: "root" }, id: "m", raw: {}, text: "hello", threadId: "thread" } as never,
    }
    await expect(state.enqueue("thread", entry, 10)).resolves.toBe(1)
    await expect(state.dequeue("thread")).resolves.toEqual(entry)

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
})
