import { createSqlLeaseStore, getInstanceId } from "@vite-hub/runtime"
import postgres from "postgres"

import { createPostgresAgentInvocationStore } from "../../src/invocations/postgres-store.ts"
import { agentInvocationPostgresClient } from "../../src/invocations/postgres-clients.ts"
import { createInvocationClaimId, failInterruptedAgentInvocations } from "../../src/server/invocation-health.ts"
import { startAgentRecoverySweep } from "../../src/server/recovery-sweep.ts"

const [role, url, tablePrefix, agentName, claimMs, intervalMs] = process.argv.slice(2)
const sql = postgres(url, { max: 2, onnotice: () => {} })
const store = createPostgresAgentInvocationStore({ client: () => agentInvocationPostgresClient(sql, "default"), maxAge: false, maxRecords: false, tablePrefix })
const print = value => process.stdout.write(`${JSON.stringify({ instance: getInstanceId(), ...value })}\n`)

if (role === "run") {
  const now = new Date().toISOString()
  const id = `inv_${crypto.randomUUID()}`
  await store.create({ agentName, createdAt: now, id, observations: [], startedAt: now, status: "running", traceId: id, updatedAt: now })
  const claimId = createInvocationClaimId()
  if (!await store.claim(id, claimId, Number(claimMs))) throw new Error("The new Invocation was not claimed.")
  setInterval(() => void store.claim(id, claimId, Number(claimMs)), Number(claimMs) / 4)
  print({ claimId, id, running: true })
}
else {
  const leases = createSqlLeaseStore({ dialect: "postgresql", query: async (text, params) => await sql.unsafe(text, params) })
  const sweep = startAgentRecoverySweep({
    agentName,
    intervalMs: Number(intervalMs),
    leases,
    onError: error => print({ error: String(error) }),
    sweep: async () => {
      const failed = await failInterruptedAgentInvocations(store, {
        agentName,
        before: Date.now() - Number(claimMs),
        claimLeaseMs: Number(claimMs),
        recover: () => true,
        waitForBlocked: false,
      })
      print({ at: Date.now(), failed, swept: true })
    },
  })
  process.once("SIGTERM", async () => {
    await sweep.stop()
    print({ stopped: true })
    await sql.end()
    process.exit(0)
  })
  setInterval(() => {}, 60_000)
  print({ ready: true })
}
