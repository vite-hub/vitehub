import { resolveChatRuntimeValue } from "./chat-options.ts"
import { createCloudflareAgentState } from "../state/providers/cloudflare.ts"

import type { Lock, QueueEntry, StateAdapter } from "chat"
import type { AgentChatOptions, ResolvedAgentModuleOptions } from "../types.ts"
import type { NitroChatRuntimeContext } from "./chat-options.ts"
import type { ViteHubAgentStateDurableObjectNamespace } from "../state/providers/cloudflare.ts"

type MemoryValue = { expiresAt?: number, value: unknown }
type MemoryList = { expiresAt?: number, values: unknown[] }

const defaultChatStates = new WeakMap<AgentChatOptions, StateAdapter>()
const configuredChatStates = new WeakMap<AgentChatOptions, StateAdapter>()
const cloudflareChatStates = new WeakMap<AgentChatOptions, WeakMap<object, StateAdapter>>()

function memoryExpiresAt(ttlMs: number | undefined): number | undefined {
  return typeof ttlMs === "number" && ttlMs > 0 ? Date.now() + ttlMs : undefined
}

function isExpired(value: { expiresAt?: number } | undefined): boolean {
  return typeof value?.expiresAt === "number" && value.expiresAt <= Date.now()
}

function createMemoryChatState(): StateAdapter {
  const values = new Map<string, MemoryValue>()
  const lists = new Map<string, MemoryList>()
  const subscriptions = new Set<string>()
  const queues = new Map<string, QueueEntry[]>()
  const locks = new Map<string, Lock>()

  return {
    async acquireLock(threadId, ttlMs) {
      const current = locks.get(threadId)
      if (current && current.expiresAt > Date.now()) return null
      const lock = { expiresAt: Date.now() + ttlMs, threadId, token: `${Date.now()}-${Math.random().toString(36).slice(2)}` }
      locks.set(threadId, lock)
      return lock
    },
    async appendToList(key, value, options) {
      const current = lists.get(key)
      const nextValues = isExpired(current) ? [value] : [...(current?.values || []), value]
      lists.set(key, {
        expiresAt: memoryExpiresAt(options?.ttlMs),
        values: typeof options?.maxLength === "number" ? nextValues.slice(-options.maxLength) : nextValues,
      })
    },
    async connect() {},
    async delete(key) {
      values.delete(key)
      lists.delete(key)
    },
    async dequeue(threadId) {
      const queue = queues.get(threadId) || []
      const entry = queue.shift() || null
      if (queue.length) queues.set(threadId, queue)
      else queues.delete(threadId)
      return entry
    },
    async disconnect() {},
    async enqueue(threadId, entry, maxSize) {
      const queue = queues.get(threadId) || []
      queue.push(entry)
      queues.set(threadId, queue.slice(-maxSize))
      return queues.get(threadId)!.length
    },
    async extendLock(lock, ttlMs) {
      const current = locks.get(lock.threadId)
      if (current?.token !== lock.token) return false
      current.expiresAt = Date.now() + ttlMs
      return true
    },
    async forceReleaseLock(threadId) {
      locks.delete(threadId)
    },
    async get(key) {
      const entry = values.get(key)
      if (isExpired(entry)) {
        values.delete(key)
        return null
      }
      return entry?.value as never || null
    },
    async getList(key) {
      const entry = lists.get(key)
      if (isExpired(entry)) {
        lists.delete(key)
        return []
      }
      return entry?.values as never || []
    },
    async isSubscribed(threadId) {
      return subscriptions.has(threadId)
    },
    async queueDepth(threadId) {
      return queues.get(threadId)?.length || 0
    },
    async releaseLock(lock) {
      if (locks.get(lock.threadId)?.token === lock.token) locks.delete(lock.threadId)
    },
    async set(key, value, ttlMs) {
      values.set(key, { expiresAt: memoryExpiresAt(ttlMs), value })
    },
    async setIfNotExists(key, value, ttlMs) {
      const current = values.get(key)
      if (current && !isExpired(current)) return false
      values.set(key, { expiresAt: memoryExpiresAt(ttlMs), value })
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

function getDefaultChatState(options: AgentChatOptions): StateAdapter {
  const current = defaultChatStates.get(options)
  if (current) return current
  const state = createMemoryChatState()
  defaultChatStates.set(options, state)
  return state
}

function getConfiguredStateProvider(context: NitroChatRuntimeContext): string {
  const agentConfig = (context.runtimeConfig as { agent?: false | ResolvedAgentModuleOptions }).agent
  return agentConfig && agentConfig.providers.state.provider || "auto"
}

function isCloudflareAgentStateProvider(provider: string): boolean {
  return provider === "auto" || provider === "cloudflare" || provider === "cloudflare-agents"
}

function isCloudflareAgentStateNamespace(value: unknown): value is ViteHubAgentStateDurableObjectNamespace & object {
  return typeof value === "object"
    && value !== null
    && typeof (value as ViteHubAgentStateDurableObjectNamespace).get === "function"
    && typeof (value as ViteHubAgentStateDurableObjectNamespace).idFromName === "function"
}

function getCloudflareChatState(options: AgentChatOptions, namespace: ViteHubAgentStateDurableObjectNamespace & object): StateAdapter {
  let states = cloudflareChatStates.get(options)
  if (!states) {
    states = new WeakMap()
    cloudflareChatStates.set(options, states)
  }
  const existing = states.get(namespace)
  if (existing) return existing
  const state = createCloudflareAgentState({ namespace })
  states.set(namespace, state)
  return state
}

function createChatStateKeyPrefix(agentName: string): string {
  const normalized = agentName
    .trim()
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
  return `_vitehub_${normalized || "agent"}_chat`
}

function namespaceChatState(state: StateAdapter, keyPrefix: string): StateAdapter {
  const prefix = `${keyPrefix}:`
  const key = (value: string) => `${prefix}${value}`
  const lock = (value: Lock): Lock => ({ ...value, threadId: key(value.threadId) })
  const unlock = (value: Lock): Lock => ({
    ...value,
    threadId: value.threadId.startsWith(prefix) ? value.threadId.slice(prefix.length) : value.threadId,
  })

  return {
    async acquireLock(threadId, ttlMs) {
      const acquired = await state.acquireLock(key(threadId), ttlMs)
      return acquired ? unlock(acquired) : null
    },
    async appendToList(listKey, value, options) {
      await state.appendToList(key(listKey), value, options)
    },
    async connect() {
      await state.connect()
    },
    async delete(cacheKey) {
      await state.delete(key(cacheKey))
    },
    async dequeue(threadId) {
      return await state.dequeue(key(threadId))
    },
    async disconnect() {
      await state.disconnect()
    },
    async enqueue(threadId, entry, maxSize) {
      return await state.enqueue(key(threadId), entry, maxSize)
    },
    async extendLock(lockValue, ttlMs) {
      return await state.extendLock(lock(lockValue), ttlMs)
    },
    async forceReleaseLock(threadId) {
      await state.forceReleaseLock(key(threadId))
    },
    async get(cacheKey) {
      return await state.get(key(cacheKey))
    },
    async getList(listKey) {
      return await state.getList(key(listKey))
    },
    async isSubscribed(threadId) {
      return await state.isSubscribed(key(threadId))
    },
    async queueDepth(threadId) {
      return await state.queueDepth(key(threadId))
    },
    async releaseLock(lockValue) {
      await state.releaseLock(lock(lockValue))
    },
    async set(cacheKey, value, ttlMs) {
      await state.set(key(cacheKey), value, ttlMs)
    },
    async setIfNotExists(cacheKey, value, ttlMs) {
      return await state.setIfNotExists(key(cacheKey), value, ttlMs)
    },
    async subscribe(threadId) {
      await state.subscribe(key(threadId))
    },
    async unsubscribe(threadId) {
      await state.unsubscribe(key(threadId))
    },
  }
}

export async function resolveChatState(
  options: AgentChatOptions,
  context: NitroChatRuntimeContext,
  agentName: string,
): Promise<StateAdapter> {
  const stateKeyPrefix = createChatStateKeyPrefix(agentName)
  if (options.state) {
    const existing = configuredChatStates.get(options)
    if (existing) return existing
    const stateContext = {
      ...context,
      chat: {
        agentName,
        stateKeyPrefix,
      },
    } as NitroChatRuntimeContext & { chat: { agentName: string, stateKeyPrefix: string } }
    const state = namespaceChatState(await resolveChatRuntimeValue<StateAdapter>(options.state, stateContext), stateContext.chat.stateKeyPrefix)
    configuredChatStates.set(options, state)
    return state
  }

  const provider = getConfiguredStateProvider(context)
  if (provider === "memory") {
    return getDefaultChatState(options)
  }
  if (!isCloudflareAgentStateProvider(provider)) {
    throw new Error(`[vitehub] Unsupported Agent State Provider "${provider}". Configure chat({ state }) or use providers.state.provider: "auto", "cloudflare", or "memory".`)
  }

  if (context.cloudflare?.env) {
    const namespace = context.cloudflare.env.CHAT_STATE
    if (!isCloudflareAgentStateNamespace(namespace)) {
      throw new Error("[vitehub] Cloudflare chat handling requires the CHAT_STATE Durable Object binding. Use @vite-hub/agent/nitro with providers.state.provider: \"auto\" or configure chat({ state }).")
    }
    return namespaceChatState(getCloudflareChatState(options, namespace), stateKeyPrefix)
  }

  if (provider !== "auto") {
    throw new Error(`[vitehub] Agent State Provider "${provider}" requires Cloudflare runtime bindings.`)
  }
  return getDefaultChatState(options)
}
