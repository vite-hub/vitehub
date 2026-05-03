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

export class MemoryChatStateAdapter implements StateAdapter {
  readonly #lists = new Map<string, ListEntry[]>()
  readonly #locks = new Map<string, Lock>()
  readonly #queues = new Map<string, QueueEntry[]>()
  readonly #subscriptions = new Set<string>()
  readonly #values = new Map<string, ValueEntry>()

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const existing = this.#locks.get(threadId)
    if (existing && existing.expiresAt > Date.now()) {
      return null
    }

    const lock = {
      expiresAt: Date.now() + ttlMs,
      threadId,
      token: createToken(),
    }
    this.#locks.set(threadId, lock)
    return lock
  }

  async appendToList(key: string, value: unknown, options: { maxLength?: number, ttlMs?: number } = {}): Promise<void> {
    const entries = this.#lists.get(key)?.filter(entry => !isExpired(entry)) ?? []
    entries.push({
      expiresAt: options.ttlMs ? Date.now() + options.ttlMs : undefined,
      value,
    })
    this.#lists.set(key, typeof options.maxLength === "number" ? entries.slice(-options.maxLength) : entries)
  }

  async connect(): Promise<void> {}

  async delete(key: string): Promise<void> {
    this.#values.delete(key)
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    const queue = this.#queues.get(threadId)?.filter(entry => entry.expiresAt > Date.now()) ?? []
    const entry = queue.shift() ?? null
    this.#queues.set(threadId, queue)
    return entry
  }

  async disconnect(): Promise<void> {}

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    const queue = this.#queues.get(threadId)?.filter(item => item.expiresAt > Date.now()) ?? []
    queue.push(entry)
    this.#queues.set(threadId, queue.slice(-maxSize))
    return this.#queues.get(threadId)!.length
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    const existing = this.#locks.get(lock.threadId)
    if (!existing || existing.token !== lock.token || existing.expiresAt <= Date.now()) {
      return false
    }

    existing.expiresAt = Date.now() + ttlMs
    return true
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    this.#locks.delete(threadId)
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.#values.get(key)
    if (!entry) {
      return null
    }
    if (isExpired(entry)) {
      this.#values.delete(key)
      return null
    }
    return entry.value as T
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    const entries = this.#lists.get(key)?.filter(entry => !isExpired(entry)) ?? []
    this.#lists.set(key, entries)
    return entries.map(entry => entry.value as T)
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    return this.#subscriptions.has(threadId)
  }

  async queueDepth(threadId: string): Promise<number> {
    const queue = this.#queues.get(threadId)?.filter(entry => entry.expiresAt > Date.now()) ?? []
    this.#queues.set(threadId, queue)
    return queue.length
  }

  async releaseLock(lock: Lock): Promise<void> {
    const existing = this.#locks.get(lock.threadId)
    if (existing?.token === lock.token) {
      this.#locks.delete(lock.threadId)
    }
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.#values.set(key, {
      expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
      value,
    })
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    if (await this.get(key) !== null) {
      return false
    }
    await this.set(key, value, ttlMs)
    return true
  }

  async subscribe(threadId: string): Promise<void> {
    this.#subscriptions.add(threadId)
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.#subscriptions.delete(threadId)
  }
}
