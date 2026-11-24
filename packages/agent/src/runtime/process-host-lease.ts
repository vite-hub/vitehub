import { getInstanceId } from "@vite-hub/runtime"

import { localAgentProcessHostIntake, registerAgentProcessHostForwardingIntake, type AgentProcessHostIntake } from "../process-host.ts"

import type { Lease, LeaseStore } from "@vite-hub/runtime"
import type { SqliteAgentStateExtension } from "../state/sqlite.ts"

/** The Lease that the process host of one Agent runs under. */
export function agentProcessHostLeaseKey(agentName: string): string {
  return `agent-process-host:${agentName}`
}

/** How long the Lease lasts without a renewal. A holder that stops is replaced within `ttl + interval`. */
export const agentProcessHostLeaseTtlMs = 25_000
/** How often each server renews or tries to take the Lease. */
export const agentProcessHostLeaseIntervalMs = 5_000

export interface AgentProcessHostLeaseOptions {
  agentName: string
  leases: LeaseStore
  /** Where a server that does not hold the Lease keeps webhook deliveries for the holder. */
  state: () => { extension(name: string): SqliteAgentStateExtension }
  ttlMs?: number
  intervalMs?: number
  /** Starts the host. Resolves `false` when it did not start. */
  promote: (canStart: () => boolean) => Promise<boolean>
  /** Stops the host. */
  demote: () => Promise<void>
  onError: (error: unknown) => void
}

export interface AgentProcessHostLease {
  /** `holder` while this server runs the host, else `standby`. */
  role(): "holder" | "standby"
  /** The owner of the Lease, when the last check saw one. */
  holder(): string | undefined
  stop(): Promise<void>
}

interface LeaseTerm {
  lease: Lease
  deadline: number
  expiry?: ReturnType<typeof setTimeout>
  startup?: Promise<void>
  renewal?: Promise<void>
  forwarding?: Promise<void>
  running: boolean
}

/**
 * Runs the process host of one Agent on one server at a time. Each server tries to take the Lease every `intervalMs`.
 * The holder renews it and runs the host. When a renewal says that another server holds the Lease, or no renewal
 * succeeds in time, the holder stops its host before the Lease can expire. The Lease expires on the Database clock,
 * and the holder counts its time from before each renewal, so host clocks do not need to agree.
 *
 * A server without the Lease keeps webhook deliveries in Agent State. The holder hands them to its host intake.
 */
export function startAgentProcessHostLease(options: AgentProcessHostLeaseOptions): AgentProcessHostLease {
  const ttlMs = options.ttlMs ?? agentProcessHostLeaseTtlMs
  const intervalMs = options.intervalMs ?? agentProcessHostLeaseIntervalMs
  const key = agentProcessHostLeaseKey(options.agentName)
  const owner = getInstanceId()
  const forward = createForwardedIntake(options.agentName, options.state)
  const windowMs = ttlMs - Math.min(intervalMs, ttlMs / 2)
  let term: LeaseTerm | undefined
  let peer: string | undefined
  let retryAt = 0
  let attempts = 0
  let acquisition: Promise<void> | undefined
  let retiring: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  let stopped = false
  const deliveries = new Set<Promise<Response>>()

  const owns = (held: LeaseTerm) => term === held && performance.now() < held.deadline
  const acceptsLocal = () => !stopped && term?.running === true && owns(term)
  const unregister = registerAgentProcessHostForwardingIntake(options.agentName, local => {
    if (!local || !acceptsLocal()) return forward.intake
    const held = term
    return (delivery) => {
      if (term !== held || !acceptsLocal()) return forward.intake(delivery)
      const pending = local(delivery).finally(() => deliveries.delete(pending))
      deliveries.add(pending)
      return pending
    }
  })

  async function release(lease: Lease): Promise<void> {
    const [error] = await lease.release()
    if (error) options.onError(error)
  }

  function retire(held: LeaseTerm, lost: boolean): Promise<void> {
    held.running = false
    if (lost) {
      term = undefined
      clearTimeout(held.expiry)
    }
    retiring ??= (async () => {
      await held.startup
      const [closed] = await Promise.all([
        options.demote().then(() => true, error => { options.onError(error); return false }),
        held.forwarding,
        Promise.allSettled(deliveries),
      ])
      if (term === held) term = undefined
      clearTimeout(held.expiry)
      if (closed) await release(held.lease)
    })().catch(options.onError).finally(() => { retiring = undefined })
    return retiring
  }

  function expireAt(held: LeaseTerm, deadline: number): void {
    clearTimeout(held.expiry)
    held.deadline = deadline
    const check = () => {
      if (term !== held) return
      const remaining = held.deadline - performance.now()
      if (remaining <= 0) void retire(held, true)
      else {
        held.expiry = setTimeout(check, Math.ceil(remaining))
        held.expiry.unref?.()
      }
    }
    check()
  }

  function forwardDeliveries(held: LeaseTerm): void {
    if (!acceptsLocal() || held.forwarding) return
    held.forwarding = forward.drain(acceptsLocal).catch(options.onError).finally(() => { held.forwarding = undefined })
  }

  async function take(): Promise<void> {
    const deadline = performance.now() + windowMs
    const [error, acquired] = await options.leases.acquire(key, { owner, ttl: ttlMs / 1000 })
    peer = undefined
    if (error) return options.onError(error)
    if (!acquired) {
      const [readError, current] = await options.leases.get(key)
      if (!readError) peer = current?.owner
      return
    }
    if (stopped || performance.now() >= deadline) return await release(acquired)
    const held: LeaseTerm = { lease: acquired, deadline, running: false }
    term = held
    expireAt(held, deadline)
    const canStart = () => !stopped && owns(held)
    held.startup = options.promote(canStart).then(started => {
      held.running = started && canStart()
      if (!started) retryAt = performance.now() + Math.min(intervalMs * 2 ** attempts++, 30 * 60_000)
      else {
        attempts = 0
        forwardDeliveries(held)
      }
    }).catch(options.onError).finally(() => {
      held.startup = undefined
      if (term === held && (!held.running || !owns(held) || stopped)) void retire(held, !owns(held))
    })
  }

  async function keep(held: LeaseTerm): Promise<void> {
    const deadline = performance.now() + windowMs
    const [error, renewed] = await held.lease.renew({ ttl: ttlMs / 1000 })
    if (term !== held) return
    if (!owns(held) || (!error && !renewed)) {
      void retire(held, true)
      return
    }
    if (error) return options.onError(error)
    expireAt(held, deadline)
  }

  function tick(): void {
    const held = term
    if (held) {
      if (!owns(held)) {
        void retire(held, true)
        return
      }
      held.renewal ??= keep(held).catch(options.onError).finally(() => { held.renewal = undefined })
      forwardDeliveries(held)
    }
    else if (!stopped && !retiring && performance.now() >= retryAt) {
      acquisition ??= take().catch(options.onError).finally(() => { acquisition = undefined })
    }
  }

  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  tick()

  return {
    role: () => acceptsLocal() ? "holder" : "standby",
    holder: () => acceptsLocal() ? owner : peer,
    stop() {
      stopped = true
      stopping ??= (async () => {
        await acquisition
        if (term) await retire(term, !owns(term))
        else await retiring
      })().finally(() => {
        clearInterval(timer)
        unregister()
      })
      return stopping
    },
  }
}

function createForwardedIntake(agentName: string, state: () => { extension(name: string): SqliteAgentStateExtension }) {
  let storage: SqliteAgentStateExtension | undefined
  let ready: Promise<void> | undefined
  const table = () => `${storage!.tablePrefix}intake`
  async function open(): Promise<SqliteAgentStateExtension> {
    storage ??= state().extension("process_host")
    ready ??= storage.execute(`CREATE TABLE IF NOT EXISTS ${table()} (agent TEXT NOT NULL, delivery_id TEXT NOT NULL, event TEXT NOT NULL,
      payload TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY (agent, delivery_id))`).then(() => undefined, (error: unknown) => {
      ready = undefined
      throw error
    })
    await ready
    return storage
  }
  const intake: AgentProcessHostIntake = async ({ deliveryId, event, payload }) => {
    const store = await open()
    await store.execute(`INSERT OR IGNORE INTO ${table()} (agent, delivery_id, event, payload, received_at)
      VALUES (?, ?, ?, ?, CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER))`, [agentName, deliveryId, event, JSON.stringify(payload ?? null)])
    return Response.json({ accepted: true, forwarded: true }, { status: 202 })
  }
  return {
    intake,
    async drain(active: () => boolean) {
      const target = localAgentProcessHostIntake(agentName)
      if (!target) return
      const store = await open()
      while (active()) {
        const rows = await store.execute(`SELECT delivery_id, event, payload FROM ${table()} WHERE agent = ? ORDER BY received_at, delivery_id LIMIT 20`, [agentName])
        if (!rows.length) return
        for (const row of rows) {
          if (!active()) return
          const deliveryId = String(row.delivery_id)
          const response = await target({ deliveryId, event: String(row.event), payload: JSON.parse(String(row.payload)) })
          if (!response.ok) return
          await store.execute(`DELETE FROM ${table()} WHERE agent = ? AND delivery_id = ?`, [agentName, deliveryId])
        }
      }
    },
  }
}
