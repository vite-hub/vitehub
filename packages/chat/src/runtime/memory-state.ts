import type { Lock, QueueEntry, StateAdapter } from "chat"

interface ListEntry {
  expiresAt?: number
  value: unknown
}

interface ValueEntry {
  expiresAt?: number
  value: unknown
}

function isExpired(entry: { expiresAt?: number }): boolean {
  return typeof entry.expiresAt === "number" && entry.expiresAt <= Date.now()
}

function createToken(): string {
  return Math.random().toString(36).slice(2)
}

export function createMemoryChatStateAdapter(): StateAdapter {
  const lists = new Map<string, ListEntry[]>()
  const locks = new Map<string, Lock>()
  const queues = new Map<string, QueueEntry[]>()
  const subscriptions = new Set<string>()
  const values = new Map<string, ValueEntry>()

  const adapter: StateAdapter = {
    async acquireLock(threadId, ttlMs) {
      const existing = locks.get(threadId)
      if (existing && existing.expiresAt > Date.now()) {
        return null
      }

      const lock = {
        expiresAt: Date.now() + ttlMs,
        threadId,
        token: createToken(),
      }
      locks.set(threadId, lock)
      return lock
    },

    async appendToList(key, value, options = {}) {
      const entries = lists.get(key)?.filter(entry => !isExpired(entry)) ?? []
      entries.push({
        expiresAt: options.ttlMs ? Date.now() + options.ttlMs : undefined,
        value,
      })
      lists.set(key, typeof options.maxLength === "number" ? entries.slice(-options.maxLength) : entries)
    },

    async connect() {},

    async delete(key) {
      values.delete(key)
    },

    async dequeue(threadId) {
      const queue = queues.get(threadId)?.filter(entry => entry.expiresAt > Date.now()) ?? []
      const entry = queue.shift() ?? null
      queues.set(threadId, queue)
      return entry
    },

    async disconnect() {},

    async enqueue(threadId, entry, maxSize) {
      const queue = queues.get(threadId)?.filter(item => item.expiresAt > Date.now()) ?? []
      queue.push(entry)
      queues.set(threadId, queue.slice(-maxSize))
      return queues.get(threadId)!.length
    },

    async extendLock(lock, ttlMs) {
      const existing = locks.get(lock.threadId)
      if (!existing || existing.token !== lock.token || existing.expiresAt <= Date.now()) {
        return false
      }

      existing.expiresAt = Date.now() + ttlMs
      return true
    },

    async forceReleaseLock(threadId) {
      locks.delete(threadId)
    },

    async get<T = unknown>(key: string): Promise<T | null> {
      const entry = values.get(key)
      if (!entry) {
        return null
      }
      if (isExpired(entry)) {
        values.delete(key)
        return null
      }
      return entry.value as T
    },

    async getList<T = unknown>(key: string): Promise<T[]> {
      const entries = lists.get(key)?.filter(entry => !isExpired(entry)) ?? []
      lists.set(key, entries)
      return entries.map(entry => entry.value as T)
    },

    async isSubscribed(threadId) {
      return subscriptions.has(threadId)
    },

    async queueDepth(threadId) {
      const queue = queues.get(threadId)?.filter(entry => entry.expiresAt > Date.now()) ?? []
      queues.set(threadId, queue)
      return queue.length
    },

    async releaseLock(lock) {
      const existing = locks.get(lock.threadId)
      if (existing?.token === lock.token) {
        locks.delete(lock.threadId)
      }
    },

    async set(key, value, ttlMs) {
      values.set(key, {
        expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
        value,
      })
    },

    async setIfNotExists(key, value, ttlMs) {
      if (await adapter.get(key) !== null) {
        return false
      }
      await adapter.set(key, value, ttlMs)
      return true
    },

    async subscribe(threadId) {
      subscriptions.add(threadId)
    },

    async unsubscribe(threadId) {
      subscriptions.delete(threadId)
    },
  }

  return adapter
}
