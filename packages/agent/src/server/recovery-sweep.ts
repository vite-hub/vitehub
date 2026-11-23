import type { Lease, LeaseStore } from "@vite-hub/runtime"

export const agentRecoverySweepIntervalMs = 15_000
/** An Invocation claim lasts this long, so a younger Invocation may still wait for its first claim. */
export const agentRecoverySweepGraceMs = 30_000

export interface AgentRecoverySweepOptions {
  agentName: string
  leases: LeaseStore
  intervalMs?: number
  sweep: () => Promise<unknown>
  onError?: (error: unknown) => void
}

export interface AgentRecoverySweep {
  /** Runs one sweep when this instance holds the Lease. Resolves `true` when it swept. */
  tick(): Promise<boolean>
  stop(): Promise<void>
}

/**
 * Sweeps the Invocation journal of one Agent every `intervalMs`. Each instance runs the timer, but only the instance
 * that holds the Lease `agent-recovery:<agent>` sweeps. The Lease lasts two intervals, so when its holder stops,
 * another instance takes it over within three intervals.
 */
export function startAgentRecoverySweep(options: AgentRecoverySweepOptions): AgentRecoverySweep {
  const intervalMs = options.intervalMs ?? agentRecoverySweepIntervalMs
  const key = `agent-recovery:${options.agentName}`
  const ttl = (2 * intervalMs) / 1000
  const report = options.onError ?? (error => console.error(`[vitehub] The recovery sweep of the Agent ${JSON.stringify(options.agentName)} failed.`, error))
  let lease: Lease | undefined
  let running: Promise<boolean> | undefined
  let stopped = false

  async function hold(): Promise<boolean> {
    if (lease) {
      const [error, renewed] = await lease.renew({ ttl })
      if (error) {
        report(error)
        return false
      }
      if (renewed) return true
      lease = undefined
    }
    const [error, acquired] = await options.leases.acquire(key, { ttl })
    if (error) {
      report(error)
      return false
    }
    lease = acquired ?? undefined
    return lease !== undefined
  }

  async function sweepOnce(): Promise<boolean> {
    if (stopped || !await hold() || stopped) return false
    await options.sweep()
    return true
  }

  function tick(): Promise<boolean> {
    running ??= sweepOnce()
      .catch((error: unknown) => {
        report(error)
        return false
      })
      .finally(() => {
        running = undefined
      })
    return running
  }

  const timer = setInterval(() => void tick(), intervalMs)
  timer.unref?.()

  return {
    tick,
    async stop() {
      stopped = true
      clearInterval(timer)
      await running
      const held = lease
      lease = undefined
      if (!held) return
      const [error] = await held.release()
      if (error) report(error)
    },
  }
}
