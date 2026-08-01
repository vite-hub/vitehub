import type { AgentDriverCapacityOptions } from "../types.ts"

type AgentCapacityRelease = () => void

interface AgentCapacityQueueEntry {
  cleanup: () => void
  resolve: (release: AgentCapacityRelease) => void
  settled: boolean
}

interface AgentCapacityScope {
  options: AgentDriverCapacityOptions
  scheduler?: AgentCapacityScheduler
}

const agentCapacityScope = Symbol("vitehub.agentCapacityScope")

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

  constructor(private readonly options: AgentDriverCapacityOptions) {}

  status(): { active: number, pending: number } {
    return { active: this.active, pending: this.queue.length }
  }

  async acquire(signal?: AbortSignal): Promise<AgentCapacityRelease> {
    if (signal?.aborted) throw capacityAbortError(signal)
    if (this.active < this.options.concurrency && this.queue.length === 0) {
      this.active++
      return this.createRelease()
    }

    const queue = this.options.queue
    if (!queue || this.queue.length >= queue.maxPending) {
      throw capacityError(
        "AGENT_CAPACITY_QUEUE_FULL",
        `[vitehub] Agent driver capacity is full (${this.options.concurrency} active, ${queue?.maxPending || 0} queued).`,
      )
    }

    return await new Promise<AgentCapacityRelease>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => settle(capacityAbortError(signal))
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      }
      const entry: AgentCapacityQueueEntry = {
        cleanup,
        resolve,
        settled: false,
      }
      const settle = (error: Error) => {
        if (entry.settled) return
        entry.settled = true
        const index = this.queue.indexOf(entry)
        if (index !== -1) this.queue.splice(index, 1)
        cleanup()
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
    })
  }

  private createRelease(): AgentCapacityRelease {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.drain()
    }
  }

  private drain(): void {
    while (this.active < this.options.concurrency && this.queue.length) {
      const entry = this.queue.shift()!
      if (entry.settled) continue
      entry.settled = true
      entry.cleanup()
      this.active++
      entry.resolve(this.createRelease())
    }
  }
}

export function configureAgentCapacity(agent: object, options: AgentDriverCapacityOptions | undefined): void {
  if (!options) return
  Object.defineProperty(agent, agentCapacityScope, {
    configurable: true,
    value: { options } satisfies AgentCapacityScope,
  })
}

export async function acquireAgentCapacity(agent: object, signal?: AbortSignal): Promise<AgentCapacityRelease | undefined> {
  const scope = (agent as { [agentCapacityScope]?: AgentCapacityScope })[agentCapacityScope]
  if (!scope) return
  scope.scheduler ||= new AgentCapacityScheduler(scope.options)
  return await scope.scheduler.acquire(signal)
}

export function inspectAgentCapacity(agent: object): (AgentDriverCapacityOptions & { active: number, pending: number }) | undefined {
  const scope = (agent as { [agentCapacityScope]?: AgentCapacityScope })[agentCapacityScope]
  if (!scope) return
  return {
    ...scope.options,
    ...(scope.scheduler?.status() || { active: 0, pending: 0 }),
  }
}
