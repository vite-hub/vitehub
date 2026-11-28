import { join } from "node:path"

import { createSqlLeaseStore, getInstanceId } from "@vite-hub/runtime"
import postgres from "postgres"

import { defineAgent } from "../../src/index.ts"
import { defineAgentInvocations } from "../../src/invocations.ts"
import { agentInvocationPostgresClient } from "../../src/invocations/postgres-clients.ts"
import { createPostgresAgentInvocationStore } from "../../src/invocations/postgres-store.ts"
import { agentProcessHostIntake, registerAgentProcessHostIntake, withAgentProcessHost } from "../../src/process-host.ts"
import { createInvocationClaimId } from "../../src/server/invocation-health.ts"
import { createAgentProcessHosts, createProcessAgentHost } from "../../src/runtime/process.ts"
import { createPostgresAgentState } from "../../src/state/postgres.ts"
import { createLibsqlAgentState } from "../../src/state/sqlite.ts"

const [url, tablePrefix, agentName, stateFile, dataDir, ttlMs, intervalMs, claimMs] = process.argv.slice(2)
const sql = postgres(url, { max: 3, onnotice: () => {} })
const store = createPostgresAgentInvocationStore({ client: () => agentInvocationPostgresClient(sql, "default"), maxAge: false, maxRecords: false, tablePrefix })
const invocations = defineAgentInvocations({ content: "content", store })
const leases = createSqlLeaseStore({ dialect: "postgresql", query: async (text, params) => await sql.unsafe(text, params) })
// `postgres` keeps Agent State in the same Postgres server, so the intake rows that forward deliveries are shared there.
const state = stateFile === "postgres"
  ? createPostgresAgentState({ client: sql, tablePrefix: `${tablePrefix}state_` })
  : createLibsqlAgentState({ url: `file:${stateFile}` })
const print = value => process.stdout.write(`${JSON.stringify({ instance: getInstanceId(), at: Date.now(), ...value })}\n`)

const agent = withAgentProcessHost(defineAgent({ name: agentName, driver: { run: () => "" } }), {
  async create(context) {
    const host = await createProcessAgentHost({
      name: agentName,
      dataDir: join(context.dataDir, getInstanceId()),
      invocations,
      invocationAgentName: agentName,
      capacity: { concurrency: 1 },
      intervalMs: 60_000,
      async run(reason) {
        if (reason !== "startup") return
        const now = new Date().toISOString()
        const id = `inv_${crypto.randomUUID()}`
        await store.create({ agentName, createdAt: now, id, observations: [], startedAt: now, status: "running", traceId: id, updatedAt: now })
        const claimId = createInvocationClaimId()
        if (!await store.claim(id, claimId, Number(claimMs))) throw new Error("The inline Invocation was not claimed.")
        setInterval(() => void store.claim(id, claimId, Number(claimMs)), Number(claimMs) / 4).unref()
        print({ invocation: id })
      },
    })
    return {
      start() {
        host.start()
        registerAgentProcessHostIntake(agentName, async ({ deliveryId }) => {
          print({ handled: deliveryId })
          return new Response(null, { status: 202 })
        })
        print({ started: true })
      },
      async close() {
        registerAgentProcessHostIntake(agentName, undefined)
        await host.close()
        print({ closed: true })
      },
      wake: reason => host.wake(reason),
      status: () => host.status(),
      health: () => host.health(),
    }
  },
})

const hosts = createAgentProcessHosts({
  names: [agentName],
  enabled: true,
  registry: { [agentName]: async () => ({ default: agent }) },
  state: () => state,
  dataDir,
  leases: () => leases,
  lease: { ttlMs: Number(ttlMs), intervalMs: Number(intervalMs) },
})
hosts.start()

process.on("message", async (message) => {
  if (message?.deliver) {
    const response = await agentProcessHostIntake(agentName)?.({ deliveryId: message.deliver, event: "ping", payload: {} })
    print({ delivered: message.deliver, status: response?.status })
  }
})
process.once("SIGTERM", async () => {
  await hosts.close()
  print({ stopped: true })
  await sql.end()
  process.exit(0)
})
setInterval(() => {}, 60_000)
print({ ready: true })
