import type { WritableWorkspaceFacade } from "@vitehub/workspace"
import type { Lock, QueueEntry, StateAdapter } from "chat"

interface StoredEntry {
  expiresAt?: number
  value: unknown
}

interface StoredState {
  lists: Record<string, StoredEntry[]>
  locks: Record<string, Lock>
  queues: Record<string, QueueEntry[]>
  subscriptions: string[]
  values: Record<string, StoredEntry>
}

const emptyState = (): StoredState => ({
  lists: {},
  locks: {},
  queues: {},
  subscriptions: [],
  values: {},
})

function isExpired(entry: { expiresAt?: number }): boolean {
  return typeof entry.expiresAt === "number" && entry.expiresAt <= Date.now()
}

function createToken(): string {
  return globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)
}

function encodeKey(key: string): string {
  return encodeURIComponent(key).replace(/~/g, "%7E")
}

export function createMemoryChatStateAdapter(): StateAdapter {
  const values = new Map<string, StoredEntry>()
  const lists = new Map<string, StoredEntry[]>()
  const locks = new Map<string, Lock>()
  const queues = new Map<string, QueueEntry[]>()
  const subscriptions = new Set<string>()
  return {
    async acquireLock(threadId, ttlMs) {
      const existing = locks.get(threadId)
      if (existing && existing.expiresAt > Date.now()) return null
      const lock = { expiresAt: Date.now() + ttlMs, threadId, token: createToken() }
      locks.set(threadId, lock)
      return lock
    },
    async appendToList(key, value, options = {}) {
      const entries = (lists.get(key) || []).filter(entry => !isExpired(entry))
      entries.push({ expiresAt: options.ttlMs ? Date.now() + options.ttlMs : undefined, value })
      lists.set(key, typeof options.maxLength === "number" ? entries.slice(-options.maxLength) : entries)
    },
    async connect() {},
    async delete(key) {
      values.delete(key)
    },
    async dequeue(threadId) {
      const queue = (queues.get(threadId) || []).filter(entry => entry.expiresAt > Date.now())
      const entry = queue.shift() ?? null
      queues.set(threadId, queue)
      return entry
    },
    async disconnect() {},
    async enqueue(threadId, entry, maxSize) {
      const queue = (queues.get(threadId) || []).filter(item => item.expiresAt > Date.now())
      queue.push(entry)
      queues.set(threadId, queue.slice(-maxSize))
      return queues.get(threadId)!.length
    },
    async extendLock(lock, ttlMs) {
      const existing = locks.get(lock.threadId)
      if (!existing || existing.token !== lock.token || existing.expiresAt <= Date.now()) return false
      existing.expiresAt = Date.now() + ttlMs
      return true
    },
    async forceReleaseLock(threadId) {
      locks.delete(threadId)
    },
    async get<T = unknown>(key: string): Promise<T | null> {
      const entry = values.get(key)
      if (!entry || isExpired(entry)) return null
      return entry.value as T
    },
    async getList<T = unknown>(key: string): Promise<T[]> {
      return (lists.get(key) || []).filter(entry => !isExpired(entry)).map(entry => entry.value as T)
    },
    async isSubscribed(threadId) {
      return subscriptions.has(threadId)
    },
    async queueDepth(threadId) {
      return (queues.get(threadId) || []).filter(entry => entry.expiresAt > Date.now()).length
    },
    async releaseLock(lock) {
      if (locks.get(lock.threadId)?.token === lock.token) locks.delete(lock.threadId)
    },
    async set(key, value, ttlMs) {
      values.set(key, { expiresAt: ttlMs ? Date.now() + ttlMs : undefined, value })
    },
    async setIfNotExists(key, value, ttlMs) {
      const existing = values.get(key)
      if (existing && !isExpired(existing)) return false
      values.set(key, { expiresAt: ttlMs ? Date.now() + ttlMs : undefined, value })
      return true
    },
    async subscribe(threadId) {
      subscriptions.add(threadId)
    },
    async unsubscribe(threadId) {
      subscriptions.delete(threadId)
    },
  }
}

export function createWorkspaceChatStateAdapter(workspace: WritableWorkspaceFacade, options: { basePath?: string } = {}): StateAdapter {
  const path = `${options.basePath || "vitehub/chat/state"}/state.json`
  let mutationQueue: Promise<unknown> = Promise.resolve()

  async function load(): Promise<StoredState> {
    try {
      return JSON.parse(await workspace.fs.readFile(path, { encoding: "utf8" })) as StoredState
    }
    catch {
      return emptyState()
    }
  }

  async function save(state: StoredState): Promise<void> {
    await workspace.fs.mkdir(path.split("/").slice(0, -1).join("/"), { recursive: true })
    await workspace.fs.writeFile(path, `${JSON.stringify(state)}\n`, { mediaType: "application/json" })
  }

  async function mutate<T>(fn: (state: StoredState) => T | Promise<T>): Promise<T> {
    const run = mutationQueue.then(async () => {
      const state = await load()
      const result = await fn(state)
      await save(state)
      return result
    })
    mutationQueue = run.then(() => undefined, () => undefined)
    return await run
  }

  return {
    async acquireLock(threadId, ttlMs) {
      return await mutate((state) => {
        const existing = state.locks[threadId]
        if (existing && existing.expiresAt > Date.now()) return null
        const lock = { expiresAt: Date.now() + ttlMs, threadId, token: createToken() }
        state.locks[threadId] = lock
        return lock
      })
    },
    async appendToList(key, value, listOptions = {}) {
      await mutate((state) => {
        const encoded = encodeKey(key)
        const entries = (state.lists[encoded] || []).filter(entry => !isExpired(entry))
        entries.push({ expiresAt: listOptions.ttlMs ? Date.now() + listOptions.ttlMs : undefined, value })
        state.lists[encoded] = typeof listOptions.maxLength === "number" ? entries.slice(-listOptions.maxLength) : entries
      })
    },
    async connect() {},
    async delete(key) {
      await mutate((state) => {
        delete state.values[encodeKey(key)]
      })
    },
    async dequeue(threadId) {
      return await mutate((state) => {
        const queue = (state.queues[threadId] || []).filter(entry => entry.expiresAt > Date.now())
        const entry = queue.shift() ?? null
        state.queues[threadId] = queue
        return entry
      })
    },
    async disconnect() {},
    async enqueue(threadId, entry, maxSize) {
      return await mutate((state) => {
        const queue = (state.queues[threadId] || []).filter(item => item.expiresAt > Date.now())
        queue.push(entry)
        state.queues[threadId] = queue.slice(-maxSize)
        return state.queues[threadId]!.length
      })
    },
    async extendLock(lock, ttlMs) {
      return await mutate((state) => {
        const existing = state.locks[lock.threadId]
        if (!existing || existing.token !== lock.token || existing.expiresAt <= Date.now()) return false
        existing.expiresAt = Date.now() + ttlMs
        return true
      })
    },
    async forceReleaseLock(threadId) {
      await mutate((state) => {
        delete state.locks[threadId]
      })
    },
    async get<T = unknown>(key: string): Promise<T | null> {
      const state = await load()
      const encoded = encodeKey(key)
      const entry = state.values[encoded]
      if (!entry || isExpired(entry)) return null
      return entry.value as T
    },
    async getList<T = unknown>(key: string): Promise<T[]> {
      const state = await load()
      return (state.lists[encodeKey(key)] || []).filter(entry => !isExpired(entry)).map(entry => entry.value as T)
    },
    async isSubscribed(threadId) {
      return (await load()).subscriptions.includes(threadId)
    },
    async queueDepth(threadId) {
      const state = await load()
      return (state.queues[threadId] || []).filter(entry => entry.expiresAt > Date.now()).length
    },
    async releaseLock(lock) {
      await mutate((state) => {
        if (state.locks[lock.threadId]?.token === lock.token) delete state.locks[lock.threadId]
      })
    },
    async set(key, value, ttlMs) {
      await mutate((state) => {
        state.values[encodeKey(key)] = { expiresAt: ttlMs ? Date.now() + ttlMs : undefined, value }
      })
    },
    async setIfNotExists(key, value, ttlMs) {
      return await mutate((state) => {
        const encoded = encodeKey(key)
        const existing = state.values[encoded]
        if (existing && !isExpired(existing)) return false
        state.values[encoded] = { expiresAt: ttlMs ? Date.now() + ttlMs : undefined, value }
        return true
      })
    },
    async subscribe(threadId) {
      await mutate((state) => {
        if (!state.subscriptions.includes(threadId)) state.subscriptions.push(threadId)
      })
    },
    async unsubscribe(threadId) {
      await mutate((state) => {
        state.subscriptions = state.subscriptions.filter(item => item !== threadId)
      })
    },
  }
}
