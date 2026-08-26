import type { StateAdapter } from "chat"

import { isRuntimeFunction, isRuntimeNumber, isRuntimeObject, isRuntimeString, isRuntimeUndefined } from "./runtime-value.ts"

export interface AgentWebhookQueueDelivery {
  concurrencyGroup: string
  concurrencyKey?: string
  concurrencyLimit: number
  channelDeliveryId?: string
  deliveryId: string
  enqueuedAt: number
  invocation?: {
    input: unknown
    run?: unknown
  }
  leaseTtlMs: number
  rehydrate?: true
  request: {
    body: string
    headers: Record<string, string>
    method: string
    url: string
  }
  scope: string
  webhookId: string
}

export interface AgentWebhookQueueLease extends AgentWebhookQueueDelivery {
  attempts: number
  leaseExpiresAt: number
  leaseToken: string
}

export interface AgentWebhookQueueStateAdapter extends StateAdapter {
  claimWebhookDelivery(scope: string): Promise<AgentWebhookQueueLease | null>
  claimWebhookSteering(delivery: AgentWebhookQueueDelivery, leaseToken: string, leaseExpiresAt: number): Promise<boolean>
  completeWebhookDelivery(scope: string, deliveryId: string, leaseToken: string): Promise<boolean>
  enqueueWebhookDelivery(delivery: AgentWebhookQueueDelivery): Promise<boolean>
  extendWebhookDeliveryLease(scope: string, deliveryId: string, leaseToken: string, ttlMs: number): Promise<boolean>
  retryWebhookDelivery(scope: string, deliveryId: string, leaseToken: string, availableAt: number, options?: { incrementAttempts?: boolean }): Promise<boolean>
  webhookDeliveryScopes(): Promise<string[]>
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRuntimeObject(value) && Object.values(value).every(isRuntimeString)
}

export function parseAgentWebhookQueueDelivery(serialized: string): AgentWebhookQueueDelivery {
  const value: unknown = JSON.parse(serialized)
  if (
    !isRuntimeObject(value) ||
    !("concurrencyGroup" in value) ||
    !isRuntimeString(value.concurrencyGroup) ||
    ("concurrencyKey" in value && !isRuntimeUndefined(value.concurrencyKey) && !isRuntimeString(value.concurrencyKey)) ||
    !("concurrencyLimit" in value) ||
    !isRuntimeNumber(value.concurrencyLimit) ||
    ("channelDeliveryId" in value && !isRuntimeUndefined(value.channelDeliveryId) && !isRuntimeString(value.channelDeliveryId)) ||
    !("deliveryId" in value) ||
    !isRuntimeString(value.deliveryId) ||
    !("enqueuedAt" in value) ||
    !isRuntimeNumber(value.enqueuedAt) ||
    !("leaseTtlMs" in value) ||
    !isRuntimeNumber(value.leaseTtlMs) ||
    !("scope" in value) ||
    !isRuntimeString(value.scope) ||
    !("webhookId" in value) ||
    !isRuntimeString(value.webhookId) ||
    !("request" in value) ||
    !isRuntimeObject(value.request) ||
    !("body" in value.request) ||
    !isRuntimeString(value.request.body) ||
    !("headers" in value.request) ||
    !isStringRecord(value.request.headers) ||
    !("method" in value.request) ||
    !isRuntimeString(value.request.method) ||
    !("url" in value.request) ||
    !isRuntimeString(value.request.url) ||
    ("invocation" in value && !isRuntimeUndefined(value.invocation) && !isRuntimeObject(value.invocation)) ||
    ("rehydrate" in value && !isRuntimeUndefined(value.rehydrate) && value.rehydrate !== true)
  ) {
    throw new TypeError("[vitehub] Agent webhook queue contains an invalid delivery.")
  }
  // SAFETY: Every persisted webhook field with a runtime contract was validated above; invocation payloads remain unknown by design.
  return value as AgentWebhookQueueDelivery
}

export function hasAgentWebhookQueue(state: StateAdapter): state is AgentWebhookQueueStateAdapter {
  // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
  const candidate = state as Partial<AgentWebhookQueueStateAdapter>
  return (
    isRuntimeFunction(candidate.claimWebhookDelivery) &&
    isRuntimeFunction(candidate.claimWebhookSteering) &&
    isRuntimeFunction(candidate.completeWebhookDelivery) &&
    isRuntimeFunction(candidate.enqueueWebhookDelivery) &&
    isRuntimeFunction(candidate.extendWebhookDeliveryLease) &&
    isRuntimeFunction(candidate.retryWebhookDelivery) &&
    isRuntimeFunction(candidate.webhookDeliveryScopes)
  )
}

export interface AgentWebhookQueueRegistration<Options> {
  backendId: string
  options: Options
  scope: string
  state: AgentWebhookQueueStateAdapter
}

export interface AgentWebhookQueueExecution<Options> extends AgentWebhookQueueRegistration<Options> {
  delivery: AgentWebhookQueueLease
  lifecycleSignal: AbortSignal
}

export interface AgentWebhookQueueRegistrar<Options> {
  register: (registration: AgentWebhookQueueRegistration<Options>) => Promise<boolean>
  track: (state: StateAdapter, options: Options, scopePrefix?: string) => void
}

export interface AgentWebhookQueue<Options> {
  admit: (registration: AgentWebhookQueueRegistration<Options>, delivery: AgentWebhookQueueDelivery) => Promise<boolean>
  idle: () => Promise<void>
  register: (registration: AgentWebhookQueueRegistration<Options>) => Promise<boolean>
  resume: (
    discover: (registrar: AgentWebhookQueueRegistrar<Options>) => Promise<void>,
    options?: { scopePrefix?: string },
  ) => () => Promise<void>
  stop: () => Promise<void>
}

interface AgentWebhookQueueOwnerOptions<Options> {
  execute: (execution: AgentWebhookQueueExecution<Options>) => Promise<number | undefined>
  resolveBackendId?: (state: AgentWebhookQueueStateAdapter) => Promise<string>
  resolveWaitUntil: (options: Options) => Promise<((task: Promise<void>) => void) | undefined>
  retryMs?: number
}

interface TrackedQueueState<Options> {
  options: Options
  scopePrefix?: string
  scopes?: Map<string, string>
}

const webhookQueueStopMessage = "[vitehub] Webhook queue stopped during Agent execution."

export function createAgentWebhookQueue<Options>(
  ownerOptions: AgentWebhookQueueOwnerOptions<Options>,
): AgentWebhookQueue<Options> {
  const retryMs = ownerOptions.retryMs ?? 1_000
  const registrations = new Map<string, AgentWebhookQueueRegistration<Options>>()
  const trackedStates = new Map<AgentWebhookQueueStateAdapter, TrackedQueueState<Options>>()
  const draining = new Set<string>()
  const pending = new Set<string>()
  const scheduled = new Map<string, { at: number; resolve: () => void; timer: ReturnType<typeof setTimeout> }>()
  const active = new Map<Promise<number | undefined>, { controller: AbortController; queueId: string }>()
  const drains = new Set<Promise<void>>()
  let stopped = false

  const queueId = (registration: AgentWebhookQueueRegistration<Options>) => `${registration.backendId}:${registration.scope}`

  let drain: (id: string) => Promise<void>
  const schedule = (id: string, at: number, waitUntil?: (task: Promise<void>) => void) => {
    if (stopped) return
    const existing = scheduled.get(id)
    if (existing && existing.at <= at) return
    if (existing) {
      clearTimeout(existing.timer)
      existing.resolve()
    }
    let resolveScheduled!: () => void
    const task = new Promise<void>((resolve) => {
      resolveScheduled = resolve
    })
    const timer = setTimeout(() => {
      scheduled.delete(id)
      void drain(id).finally(resolveScheduled)
    }, Math.max(0, at - Date.now()))
    timer.unref?.()
    scheduled.set(id, { at, resolve: resolveScheduled, timer })
    waitUntil?.(task)
  }

  const drainOnce = async (id: string) => {
    const registration = registrations.get(id)
    if (stopped || !registration) return
    if (draining.has(id)) {
      pending.add(id)
      return
    }
    draining.add(id)
    try {
      const waitUntil = await ownerOptions.resolveWaitUntil(registration.options)
      while (!stopped) {
        const delivery = await registration.state.claimWebhookDelivery(registration.scope)
        if (!delivery) {
          if (![...active.values()].some(item => item.queueId === id)) schedule(id, Date.now() + retryMs)
          break
        }
        if (stopped) {
          await registration.state
            .retryWebhookDelivery(registration.scope, delivery.deliveryId, delivery.leaseToken, Date.now(), { incrementAttempts: false })
            .catch(() => undefined)
          break
        }
        const controller = new AbortController()
        const task = ownerOptions.execute({ ...registration, delivery, lifecycleSignal: controller.signal })
        active.set(task, { controller, queueId: id })
        waitUntil?.(task.then(() => undefined))
        void task
          .then((retryAt) => {
            for (const registeredId of registrations.keys()) {
              if (registeredId !== id) void drain(registeredId)
            }
            if (retryAt === undefined || retryAt <= Date.now()) void drain(id)
            else schedule(id, retryAt, waitUntil)
          })
          .catch((error) => {
            console.error(`[vitehub] Queued webhook delivery "${delivery.deliveryId}" stopped unexpectedly.`, error)
            schedule(id, Date.now() + retryMs, waitUntil)
          })
          .finally(() => active.delete(task))
      }
    }
    catch (error) {
      console.error("[vitehub] Webhook queue drain failed and will be retried.", error)
      schedule(id, Date.now() + retryMs, await ownerOptions.resolveWaitUntil(registration.options))
    }
    finally {
      draining.delete(id)
      if (pending.delete(id)) void drain(id)
    }
  }

  drain = (id) => {
    const task = drainOnce(id)
    drains.add(task)
    void task.finally(() => drains.delete(task))
    return task
  }

  const register = async (registration: AgentWebhookQueueRegistration<Options>) => {
    if (!hasAgentWebhookQueue(registration.state)) return false
    const tracked = trackedStates.get(registration.state)
    if (tracked?.scopes) tracked.scopes.set(registration.scope, registration.backendId)
    else if (!tracked) trackedStates.set(registration.state, {
      options: registration.options,
      scopes: new Map([[registration.scope, registration.backendId]]),
    })
    const id = queueId(registration)
    registrations.set(id, registration)
    const task = drain(id)
    const waitUntil = await ownerOptions.resolveWaitUntil(registration.options)
    waitUntil?.(task)
    return true
  }

  const track = (state: StateAdapter, options: Options, scopePrefix?: string) => {
    if (!hasAgentWebhookQueue(state) || trackedStates.has(state)) return
    trackedStates.set(state, { options, scopePrefix })
  }

  const discoverTrackedScopes = async (defaultScopePrefix?: string) => {
    for (const [state, tracked] of trackedStates) {
      const persisted = new Set(await state.webhookDeliveryScopes())
      if (tracked.scopes) {
        for (const [scope, backendId] of tracked.scopes) {
          if (persisted.has(scope)) await register({ backendId, options: tracked.options, scope, state })
        }
        continue
      }
      if (!ownerOptions.resolveBackendId) continue
      const backendId = await ownerOptions.resolveBackendId(state)
      const scopePrefix = tracked.scopePrefix ?? defaultScopePrefix
      for (const scope of persisted) {
        if (!scopePrefix || scope.startsWith(scopePrefix)) await register({ backendId, options: tracked.options, scope, state })
      }
    }
  }

  const idle = async () => {
    while (drains.size || active.size) {
      await Promise.allSettled([...drains, ...active.keys()])
    }
  }

  const stop = async () => {
    stopped = true
    for (const timer of scheduled.values()) {
      clearTimeout(timer.timer)
      timer.resolve()
    }
    scheduled.clear()
    pending.clear()
    for (const { controller } of active.values()) controller.abort(new Error(webhookQueueStopMessage))
    await idle()
  }

  return {
    async admit(registration, delivery) {
      const admitted = await registration.state.enqueueWebhookDelivery(delivery)
      await register(registration)
      return admitted
    },
    idle,
    register,
    resume(discover, resumeOptions = {}) {
      stopped = false
      let discovery: Promise<void> | undefined
      let discovered = false
      const runDiscovery = async () => {
        if (stopped || discovery) return
        discovery = (async () => {
          if (!discovered) {
            await discover({ register, track })
            discovered = true
          }
          await discoverTrackedScopes(resumeOptions.scopePrefix)
        })()
          .catch(error => console.error("[vitehub] Webhook queue discovery failed and will be retried.", error))
          .finally(() => {
            discovery = undefined
          })
        await discovery
      }
      void runDiscovery()
      const timer = setInterval(() => {
        if (stopped) return
        void runDiscovery()
        for (const id of registrations.keys()) void drain(id)
      }, retryMs)
      timer.unref?.()
      return async () => {
        clearInterval(timer)
        await stop()
      }
    },
    stop,
  }
}
