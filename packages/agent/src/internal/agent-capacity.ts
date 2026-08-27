import type { AgentDriverCapacityOptions } from "../types.ts"

type AgentCapacityRelease = () => void

interface AgentCapacityQueueEntry {
  cleanup: () => void
  reject: (error: Error) => void
  resolve: (release: AgentCapacityRelease) => void
  settled: boolean
}

interface AgentCapacityScope {
  options: AgentDriverCapacityOptions
  scheduler?: AgentCapacityScheduler
}

const agentCapacityScope = Symbol("vitehub.agentCapacityScope")
const sharedAgentCapacity = Symbol.for("vitehub.agent.shared-capacity")
const sharedAgentCapacityScopes = new WeakMap<object, AgentCapacityScope>()

type AgentCapacityStatus = {
  active: number
  effectiveConcurrency?: number
  lastSampleAt?: number
  pending: number
  reason?: string
}

type AgentCapacityInspection = Omit<AgentDriverCapacityOptions, "adaptive"> & AgentCapacityStatus

function capacityError(code: string, message: string, name = "Error"): Error & { code: string } {
  return Object.assign(new Error(message), { code, name })
}

function capacityAbortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : capacityError(
        "AGENT_CAPACITY_QUEUE_ABORTED",
        "[vitehub] Agent invocation was aborted while waiting for driver capacity.",
        "AbortError",
      )
}

class AgentCapacityScheduler {
  private active = 0
  private readonly queue: AgentCapacityQueueEntry[] = []
  private effectiveConcurrency: number
  private lastSampleAt?: number
  private refreshPromise?: Promise<void>
  private refreshTimer?: ReturnType<typeof setTimeout>
  private reason?: string
  private draining = false

  constructor(private readonly options: AgentDriverCapacityOptions) {
    this.effectiveConcurrency = options.adaptive?.fallbackConcurrency ?? options.concurrency
  }

  status(): AgentCapacityStatus {
    return {
      active: this.active,
      pending: this.pendingCount(),
      ...(this.options.adaptive
        ? {
            effectiveConcurrency: this.effectiveConcurrency,
            ...(this.lastSampleAt === undefined ? {} : { lastSampleAt: this.lastSampleAt }),
            ...(this.reason === undefined ? {} : { reason: this.reason }),
          }
        : {}),
    }
  }

  async acquire(signal?: AbortSignal): Promise<AgentCapacityRelease> {
    if (signal?.aborted) throw capacityAbortError(signal)
    const queue = this.options.queue
    if (queue && this.refreshDue()) {
      const prospectiveAdmissions = Math.max(0, this.options.concurrency - this.active)
      return await this.enqueue(queue, signal, queue.maxPending + prospectiveAdmissions)
    }

    await this.refreshForAdmission(signal)
    if (signal?.aborted) throw capacityAbortError(signal)
    if (this.active < this.effectiveConcurrency && this.queue.length === 0) {
      this.active++
      return this.createRelease()
    }

    if (!queue || this.queue.length >= queue.maxPending) {
      throw capacityError(
        "AGENT_CAPACITY_QUEUE_FULL",
        `[vitehub] Agent driver capacity is full (${this.active} active, ${queue?.maxPending || 0} queued).`,
      )
    }
    return await this.enqueue(queue, signal)
  }

  private enqueue(
    queue: NonNullable<AgentDriverCapacityOptions["queue"]>,
    signal: AbortSignal | undefined,
    maxWaiting = queue.maxPending,
  ): Promise<AgentCapacityRelease> {
    if (this.queue.length >= maxWaiting) {
      return Promise.reject(capacityError(
        "AGENT_CAPACITY_QUEUE_FULL",
        `[vitehub] Agent driver capacity is full (${this.active} active, ${queue.maxPending} queued).`,
      ))
    }
    return new Promise<AgentCapacityRelease>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => settle(capacityAbortError(signal))
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      }
      const entry: AgentCapacityQueueEntry = {
        cleanup,
        reject,
        resolve,
        settled: false,
      }
      const settle = (error: Error) => {
        if (entry.settled) return
        entry.settled = true
        const index = this.queue.indexOf(entry)
        if (index !== -1) this.queue.splice(index, 1)
        cleanup()
        this.clearRefreshTimerIfIdle()
        reject(error)
      }

      signal?.addEventListener("abort", onAbort, { once: true })
      if (queue.timeout !== undefined) {
        timer = setTimeout(() => settle(capacityError(
          "AGENT_CAPACITY_QUEUE_TIMEOUT",
          `[vitehub] Agent invocation timed out after ${queue.timeout}ms while waiting for driver capacity.`,
          "TimeoutError",
        )), queue.timeout)
      }
      this.queue.push(entry)
      void this.drain()
    })
  }

  private createRelease(): AgentCapacityRelease {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      void this.drain()
    }
  }

  private async refresh(): Promise<void> {
    const adaptive = this.options.adaptive
    if (!adaptive) return
    const intervalMs = adaptive.intervalMs ?? 5_000
    const now = Date.now()
    if (this.lastSampleAt !== undefined && now - this.lastSampleAt < intervalMs) return
    if (this.refreshPromise) return await this.refreshPromise

    const sampleTimeoutMs = adaptive.sampleTimeoutMs ?? 1_000
    const sampleController = new AbortController()
    let sampleTimer: ReturnType<typeof setTimeout> | undefined
    const sample = Promise.resolve().then(() => adaptive.sample({
      active: this.active,
      concurrency: this.options.concurrency,
      pending: this.queue.length,
      signal: sampleController.signal,
    }))
    const timeout = new Promise<never>((_resolve, reject) => {
      sampleTimer = setTimeout(() => {
        const error = capacityError(
          "AGENT_CAPACITY_SAMPLE_TIMEOUT",
          `[vitehub] Adaptive Agent capacity sample timed out after ${sampleTimeoutMs}ms.`,
          "TimeoutError",
        )
        reject(error)
        sampleController.abort(error)
      }, sampleTimeoutMs)
    })
    this.refreshPromise = Promise.race([sample, timeout])
      .finally(() => {
        if (sampleTimer !== undefined) clearTimeout(sampleTimer)
      })
      .then((sample) => {
        if (!sample || !Number.isFinite(sample.concurrency)) {
          throw new TypeError("[vitehub] Adaptive Agent capacity sample must contain a finite concurrency.")
        }
        const target = Math.max(0, Math.min(this.options.concurrency, Math.floor(sample.concurrency)))
        const rampUp = adaptive.rampUp ?? 1
        this.effectiveConcurrency = target > this.effectiveConcurrency
          ? Math.min(target, this.effectiveConcurrency + rampUp)
          : target
        this.reason = typeof sample.reason === "string" && sample.reason ? sample.reason : undefined
      })
      .catch((error) => {
        const fallbackConcurrency = adaptive.fallbackConcurrency ?? 1
        this.effectiveConcurrency = Math.max(0, Math.min(this.options.concurrency, fallbackConcurrency))
        this.reason = `sample-error: ${error instanceof Error ? error.message : String(error)}`
      })
      .finally(() => {
        this.lastSampleAt = Date.now()
        this.refreshPromise = undefined
      })
    return await this.refreshPromise
  }

  private async refreshForAdmission(signal: AbortSignal | undefined): Promise<void> {
    const refresh = this.refresh()
    if (!signal) return await refresh
    if (signal.aborted) throw capacityAbortError(signal)

    let onAbort: (() => void) | undefined
    const abort = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(capacityAbortError(signal))
      signal.addEventListener("abort", onAbort, { once: true })
    })
    try {
      await Promise.race([refresh, abort])
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort)
    }
  }

  private refreshDue(): boolean {
    const adaptive = this.options.adaptive
    if (!adaptive) return false
    if (this.refreshPromise) return true
    return this.lastSampleAt === undefined
      || Date.now() - this.lastSampleAt >= (adaptive.intervalMs ?? 5_000)
  }

  private scheduleRefresh(): void {
    const adaptive = this.options.adaptive
    if (!adaptive || this.refreshTimer !== undefined || !this.queue.length) return
    const intervalMs = adaptive.intervalMs ?? 5_000
    const elapsed = this.lastSampleAt === undefined ? intervalMs : Date.now() - this.lastSampleAt
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      void this.drain()
    }, Math.max(0, intervalMs - elapsed))
  }

  private clearRefreshTimerIfIdle(): void {
    if (this.queue.length || this.refreshTimer === undefined) return
    clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      await this.refresh()
      const queue = this.options.queue
      if (queue) {
        const maxWaiting = Math.max(0, this.effectiveConcurrency - this.active) + queue.maxPending
        while (this.queue.length > maxWaiting) {
          const entry = this.queue.pop()!
          if (entry.settled) continue
          entry.settled = true
          entry.cleanup()
          entry.reject(capacityError(
            "AGENT_CAPACITY_QUEUE_FULL",
            `[vitehub] Agent driver capacity is full (${this.active} active, ${queue.maxPending} queued).`,
          ))
        }
      }
      while (this.active < this.effectiveConcurrency && this.queue.length) {
        const entry = this.queue.shift()!
        if (entry.settled) continue
        entry.settled = true
        entry.cleanup()
        this.active++
        entry.resolve(this.createRelease())
      }
    } finally {
      this.draining = false
      this.clearRefreshTimerIfIdle()
      this.scheduleRefresh()
    }
  }

  private pendingCount(): number {
    if (!this.refreshPromise) return this.queue.length
    const prospectiveAdmissions = Math.max(0, this.options.concurrency - this.active)
    return Math.max(0, this.queue.length - prospectiveAdmissions)
  }
}

export function shareAgentCapacityOptions<T extends AgentDriverCapacityOptions>(options: T): T {
  if (!(options as T & { [sharedAgentCapacity]?: object })[sharedAgentCapacity]) {
    Object.defineProperty(options, sharedAgentCapacity, { value: {} })
  }
  return options
}

export function inheritSharedAgentCapacityOptions(source: object, target: object): void {
  const shared = (source as { [sharedAgentCapacity]?: object })[sharedAgentCapacity]
  if (!shared) return
  Object.defineProperty(target, sharedAgentCapacity, { value: shared })
}

export function configureAgentCapacity(agent: object, options: AgentDriverCapacityOptions | undefined): void {
  if (!options) return
  const shared = (options as AgentDriverCapacityOptions & { [sharedAgentCapacity]?: object })[sharedAgentCapacity]
  let scope = shared && sharedAgentCapacityScopes.get(shared)
  if (!scope) {
    scope = { options }
    if (shared) sharedAgentCapacityScopes.set(shared, scope)
  }
  Object.defineProperty(agent, agentCapacityScope, {
    configurable: true,
    value: scope,
  })
}

export function inheritAgentCapacity(source: object, target: object): void {
  const scope = (source as { [agentCapacityScope]?: AgentCapacityScope })[agentCapacityScope]
  if (!scope) return
  Object.defineProperty(target, agentCapacityScope, {
    configurable: true,
    value: scope,
  })
}

export async function acquireAgentCapacity(agent: object, signal?: AbortSignal): Promise<AgentCapacityRelease | undefined> {
  const scope = (agent as { [agentCapacityScope]?: AgentCapacityScope })[agentCapacityScope]
  if (!scope) return
  scope.scheduler ||= new AgentCapacityScheduler(scope.options)
  return await scope.scheduler.acquire(signal)
}

export function inspectAgentCapacity(agent: object): AgentCapacityInspection | undefined {
  const scope = (agent as { [agentCapacityScope]?: AgentCapacityScope })[agentCapacityScope]
  if (!scope) return
  const { adaptive, ...options } = scope.options
  const status = scope.scheduler?.status() || {
    active: 0,
    pending: 0,
    ...(adaptive ? { effectiveConcurrency: adaptive.fallbackConcurrency ?? scope.options.concurrency } : {}),
  }
  return {
    ...options,
    ...(scope.options.queue ? { queue: { ...scope.options.queue } } : {}),
    ...status,
  }
}
