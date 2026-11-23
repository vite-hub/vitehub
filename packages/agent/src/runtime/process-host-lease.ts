import { getInstanceId } from "@vite-hub/runtime"

import { agentProcessHostIntake, registerAgentProcessHostIntake, type AgentProcessHostIntake } from "../process-host.ts"

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
  promote: () => Promise<boolean>
  /** Stops the host. */
  demote: () => Promise<void>
  onError: (error: unknown) => void
}

export interface AgentProcessHostLease {
  /** `holder` while this server runs the host, else `standby`. */
  role(): "holder" | "standby"
  /** The owner of the Lease, when the last check saw one. */
  holder(): string | undefined
  tick(): Promise<void>
  stop(): Promise<void>
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
  let lease: Lease | undefined
  let holder: string | undefined
  let running = false
  let heldUntil = 0
  let retryAt = 0
  let attempts = 0
  let pending: Promise<void> | undefined
  let stopped = false

  forward.register()

  async function demote(): Promise<void> {
    const held = lease
    lease = undefined
    try {
      if (running) {
        running = false
        await options.demote()
      }
    }
    finally {
      forward.register()
    }
    if (held) {
      const [error] = await held.release()
      if (error) options.onError(error)
    }
  }

  async function take(): Promise<void> {
    if (performance.now() < retryAt) return
    const [error, acquired] = await options.leases.acquire(key, { owner, ttl: ttlMs / 1000 })
    if (error) return options.onError(error)
    if (!acquired) {
      const [readError, current] = await options.leases.get(key)
      holder = readError ? holder : current?.owner
      return
    }
    lease = acquired
    holder = owner
    heldUntil = performance.now() + ttlMs
    if (stopped) return await demote()
    if (await options.promote()) {
      running = true
      attempts = 0
      await forward.drain().catch(options.onError)
      return
    }
    retryAt = performance.now() + Math.min(intervalMs * 2 ** attempts++, 30 * 60_000)
    await demote()
  }

  async function keep(held: Lease): Promise<void> {
    const startedAt = performance.now()
    const [error, renewed] = await held.renew({ ttl: ttlMs / 1000 })
    if (error) {
      options.onError(error)
      if (performance.now() + intervalMs >= heldUntil) await demote()
      return
    }
    if (!renewed) return await demote()
    heldUntil = startedAt + ttlMs
    await forward.drain().catch(options.onError)
  }

  function tick(): Promise<void> {
    pending ??= (async () => {
      if (stopped) return
      if (lease) await keep(lease)
      else await take()
    })()
      .catch(options.onError)
      .finally(() => {
        pending = undefined
      })
    return pending
  }

  const timer = setInterval(() => void tick(), intervalMs)
  timer.unref?.()
  void tick()

  return {
    role: () => (running ? "holder" : "standby"),
    holder: () => holder,
    tick,
    async stop() {
      stopped = true
      clearInterval(timer)
      await pending
      await demote()
      forward.unregister()
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
    register() {
      registerAgentProcessHostIntake(agentName, intake)
    },
    unregister() {
      if (agentProcessHostIntake(agentName) === intake) registerAgentProcessHostIntake(agentName, undefined)
    },
    async drain() {
      const target = agentProcessHostIntake(agentName)
      if (!target || target === intake) return
      const store = await open()
      for (;;) {
        const rows = await store.execute(`SELECT delivery_id, event, payload FROM ${table()} WHERE agent = ? ORDER BY received_at, delivery_id LIMIT 20`, [agentName])
        if (!rows.length) return
        for (const row of rows) {
          const deliveryId = String(row.delivery_id)
          await target({ deliveryId, event: String(row.event), payload: JSON.parse(String(row.payload)) })
          await store.execute(`DELETE FROM ${table()} WHERE agent = ? AND delivery_id = ?`, [agentName, deliveryId])
        }
      }
    },
  }
}
