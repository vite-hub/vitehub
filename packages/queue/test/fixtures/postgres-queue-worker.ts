// One app instance for the postgres provider tests. It takes jobs of the "jobs" Queue from the shared table, and
// records each start and end of a handler in `<table>_runs` with its own client.
import postgres from "postgres"

import { createPostgresQueueEngine } from "../../src/providers/postgres.ts"

const url = process.env.VITEHUB_TEST_POSTGRES_URL ?? ""
const table = process.env.QUEUE_TABLE ?? ""
const worker = process.env.WORKER_NAME ?? "worker"
const runs = postgres(url, { max: 2, onnotice: () => {} })

async function record(key: string, attempts: number, phase: "done" | "start") {
  await runs`insert into ${runs(`${table}_runs`)} (key, worker, attempts, phase) values (${key}, ${worker}, ${attempts}, ${phase})`
}

const engine = createPostgresQueueEngine({
  load: async () => ({
    async handler({ attempts, payload }) {
      const { hold, key } = payload as { hold?: boolean, key: string }
      await record(key, attempts, "start")
      // The test kills this process while it holds the job.
      await new Promise(resolve => setTimeout(resolve, hold && attempts === 1 ? 60_000 : 5))
      await record(key, attempts, "done")
    },
  }),
  lockSeconds: Number(process.env.LOCK_SECONDS ?? 30),
  missing: queue => new Error(`No Queue Definition ${queue}`),
  pollIntervalMs: 200,
  queues: () => ["jobs"],
  table,
  connection: { url },
  workerId: worker,
})

await engine.start()
process.on("SIGTERM", () => {
  void engine.close().then(() => runs.end()).then(() => process.exit(0))
})
console.log("ready")
