import { invariant } from "@vite-hub/internal/invariant"
import type { AgentStateCacheMutation, AtomicAgentStateLockAdapter } from "../../internal/state-lock.ts"
import type { Lock, QueueEntry, StateAdapter } from "chat"

import { parseAgentStateQueueEntry } from "../../internal/state-queue.ts"
import { agentDiagnostics } from "../../agent-diagnostics.ts"

export interface ViteHubAgentStateDurableObjectStub {
  acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> | Lock | null
  acquireLockWith(threadId: string, ttlMs: number, mutations: readonly AgentStateCacheMutation[], keys: readonly string[]): Promise<{ lock: Lock | null, values: Array<string | null> }> | { lock: Lock | null, values: Array<string | null> }
  cacheMutateWithLock(threadId: string, token: string, mutations: readonly AgentStateCacheMutation[]): Promise<boolean> | boolean
  cacheDelete(key: string): Promise<void> | void
  cacheGet(key: string): Promise<string | null> | string | null
  cacheSet(key: string, value: string, ttlMs?: number): Promise<void> | void
  cacheSetIfNotExists(key: string, value: string, ttlMs?: number): Promise<boolean> | boolean
  dequeue(threadId: string): Promise<string | null> | string | null
  enqueue(threadId: string, value: string, maxSize: number): Promise<number> | number
  extendLock(threadId: string, token: string, ttlMs: number): Promise<boolean> | boolean
  forceReleaseLock(threadId: string): Promise<void> | void
  isSubscribed(threadId: string): Promise<boolean> | boolean
  listAppend(key: string, value: string, maxLength?: number, ttlMs?: number): Promise<void> | void
  listGet(key: string): Promise<string[]> | string[]
  queuePeek(threadId: string): Promise<string | null> | string | null
  queueReplaceHead(threadId: string, expected: string | null, replacement: string[], maxSize: number): Promise<boolean> | boolean
  queueDepth(threadId: string): Promise<number> | number
  releaseLock(threadId: string, token: string): Promise<void> | void
  releaseLockWith(threadId: string, token: string, mutations: readonly AgentStateCacheMutation[], keys: readonly string[]): Promise<{ committed: boolean, values: Array<string | null> }> | { committed: boolean, values: Array<string | null> }
  subscribe(threadId: string): Promise<void> | void
  unsubscribe(threadId: string): Promise<void> | void
}

export interface ViteHubAgentStateDurableObjectNamespace {
  get(id: unknown, options?: { locationHint?: string }): ViteHubAgentStateDurableObjectStub
  idFromName(name: string): unknown
}

export interface CloudflareAgentStateOptions {
  locationHint?: string
  name?: string
  namespace: ViteHubAgentStateDurableObjectNamespace
  shardKey?: (threadId: string) => string
}

export class ViteHubAgentStateAdapter implements StateAdapter {
  readonly durable = true
  private connected = false
  private readonly defaultName: string
  private readonly locationHint?: string
  private readonly namespace: ViteHubAgentStateDurableObjectNamespace
  private readonly shardKey?: (threadId: string) => string

  constructor(options: CloudflareAgentStateOptions) {
    if (!options.namespace) {
      throw agentDiagnostics.AGENT_R0847({ message: "[vitehub] Cloudflare Agent State requires the CHAT_STATE Durable Object binding." })
    }
    this.namespace = options.namespace
    this.defaultName = options.name || "default"
    this.locationHint = options.locationHint
    this.shardKey = options.shardKey
  }

  forCacheLocks(): AtomicAgentStateLockAdapter {
    this.ensureConnected()
    // Cache stays on its existing default actor; only mailbox locks stop using thread sharding.
    const scoped = new ViteHubAgentStateAdapter({ namespace: this.namespace, name: this.defaultName, locationHint: this.locationHint })
    scoped.connected = true
    return scoped
  }

  async mutateWithLock(lock: Lock, mutations: readonly AgentStateCacheMutation[]): Promise<boolean> {
    invariant(!this.shardKey || this.shardKey(lock.threadId) === this.defaultName, "ViteHub calls forCacheLocks() before cache lease mutations on a sharded State")
    return await this.stub().cacheMutateWithLock(lock.threadId, lock.token, mutations)
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    return await this.stub(threadId).acquireLock(threadId, ttlMs)
  }

  async acquireLockWith(threadId: string, ttlMs: number, mutations: readonly AgentStateCacheMutation[], keys: readonly string[]): Promise<{ lock: Lock | null, values: unknown[] }> {
    invariant(!this.shardKey || this.shardKey(threadId) === this.defaultName, "ViteHub calls forCacheLocks() before cache lease mutations on a sharded State")
    const result = await this.stub().acquireLockWith(threadId, ttlMs, mutations, keys)
    return { lock: result.lock, values: result.values.map(parseCacheValue) }
  }

  async releaseLockWith(lock: Lock, mutations: readonly AgentStateCacheMutation[], keys: readonly string[]): Promise<{ committed: boolean, values: unknown[] }> {
    invariant(!this.shardKey || this.shardKey(lock.threadId) === this.defaultName, "ViteHub calls forCacheLocks() before cache lease mutations on a sharded State")
    const result = await this.stub().releaseLockWith(lock.threadId, lock.token, mutations, keys)
    return { committed: result.committed, values: result.values.map(parseCacheValue) }
  }

  async appendToList(key: string, value: unknown, options?: { maxLength?: number; ttlMs?: number }): Promise<void> {
    await this.stub().listAppend(key, JSON.stringify(value), options?.maxLength, options?.ttlMs)
  }

  async connect(): Promise<void> {
    this.connected = true
  }

  async delete(key: string): Promise<void> {
    await this.stub().cacheDelete(key)
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    const raw = await this.stub(threadId).dequeue(threadId)
    return raw === null ? null : parseAgentStateQueueEntry(raw)
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    return await this.stub(threadId).enqueue(threadId, JSON.stringify(entry), maxSize)
  }

  async queuePeek(threadId: string): Promise<QueueEntry | null> {
    const raw = await this.stub(threadId).queuePeek(threadId)
    return raw === null ? null : parseAgentStateQueueEntry(raw)
  }

  async queueReplaceHead(threadId: string, expected: QueueEntry | null, replacement: QueueEntry[], maxSize: number): Promise<boolean> {
    return await this.stub(threadId).queueReplaceHead(
      threadId,
      expected === null ? null : JSON.stringify(expected),
      replacement.map((entry) => JSON.stringify(entry)),
      maxSize,
    )
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    return await this.stub(lock.threadId).extendLock(lock.threadId, lock.token, ttlMs)
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    await this.stub(threadId).forceReleaseLock(threadId)
  }

  async get<T = unknown>(
    key: string,
    parse: (value: unknown) => T = (value) => {
      // SAFETY: State values are JSON-compatible and callers may provide a parser when they require a narrower runtime contract.
      return value as T
    },
  ): Promise<T | null> {
    const raw = await this.stub().cacheGet(key)
    if (raw === null) return null
    const value: unknown = JSON.parse(raw)
    return parse(value)
  }

  async getList<T = unknown>(
    key: string,
    parse: (value: unknown) => T = (value) => {
      // SAFETY: State list values are JSON-compatible and callers may provide a parser when they require a narrower runtime contract.
      return value as T
    },
  ): Promise<T[]> {
    return (await this.stub().listGet(key)).map((serialized) => {
      const value: unknown = JSON.parse(serialized)
      return parse(value)
    })
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    return await this.stub(threadId).isSubscribed(threadId)
  }

  async queueDepth(threadId: string): Promise<number> {
    return await this.stub(threadId).queueDepth(threadId)
  }

  async releaseLock(lock: Lock): Promise<void> {
    await this.stub(lock.threadId).releaseLock(lock.threadId, lock.token)
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    await this.stub().cacheSet(key, JSON.stringify(value), ttlMs)
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    return await this.stub().cacheSetIfNotExists(key, JSON.stringify(value), ttlMs)
  }

  async subscribe(threadId: string): Promise<void> {
    await this.stub(threadId).subscribe(threadId)
  }

  async unsubscribe(threadId: string): Promise<void> {
    await this.stub(threadId).unsubscribe(threadId)
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw agentDiagnostics.AGENT_R0848({ message: "[vitehub] Cloudflare Agent State is not connected. Call connect() before using state." })
    }
  }

  private stub(threadId?: string): ViteHubAgentStateDurableObjectStub {
    this.ensureConnected()
    const name = threadId && this.shardKey ? this.shardKey(threadId) : this.defaultName
    const id = this.namespace.idFromName(name)
    return this.locationHint ? this.namespace.get(id, { locationHint: this.locationHint }) : this.namespace.get(id)
  }
}

function parseCacheValue(raw: string | null): unknown {
  return raw === null ? null : JSON.parse(raw)
}

export function createCloudflareAgentState(options: CloudflareAgentStateOptions): StateAdapter {
  return new ViteHubAgentStateAdapter(options)
}
