import { isRuntimeNumber } from "../../src/internal/runtime-value.ts"

import type { Lock } from "chat"
import type { ViteHubAgentStateDurableObjectNamespace, ViteHubAgentStateDurableObjectStub } from "../../src/state/providers/cloudflare.ts"

/** An in-memory Durable Object namespace for the Cloudflare Agent State. */
export function createFakeCloudflareStateNamespace(): ViteHubAgentStateDurableObjectNamespace {
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
    cacheMutateWithLock(threadId, token, mutations) {
      const held = locks.get(threadId)
      if (!held || held.token !== token || held.expiresAt <= Date.now()) return false
      for (const mutation of mutations) {
        if (mutation.type === "delete") values.delete(mutation.key)
        else values.set(mutation.key, JSON.stringify(mutation.value))
      }
      return true
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
