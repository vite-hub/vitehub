// One server process for `process-postgres.test.ts`. It runs the built Process Runtime with leases on Postgres and a
// clock that runs `SPEED` times faster than real time, so a `* * * * *` Schedule is due every few seconds.
import { createSqlLeaseStore } from "@vite-hub/runtime"
import { createMemoryScheduleRunStore } from "@vite-hub/schedule/runtime"
import { installProcessScheduleRuntime } from "@vite-hub/schedule/runtime/process"
import postgres from "postgres"

const { CRASH_AT, DATABASE_URL, FAKE_START, LEASE_TTL_MS, REAL_START, SPEED } = process.env
const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} })
const now = () => new Date(Number(FAKE_START) + (Date.now() - Number(REAL_START)) * Number(SPEED))

const controller = await installProcessScheduleRuntime({
  catchUpMs: 0,
  intervalMs: 200,
  leaseTtlMs: Number(LEASE_TTL_MS),
  leases: createSqlLeaseStore({ dialect: "postgresql", query: async (text, params) => await sql.unsafe(text, params) }),
  now,
  onError: error => console.error(`[${process.pid}]`, error),
  registry: {
    tick: async () => ({
      cron: "* * * * *",
      async handler({ scheduledAt }) {
        const at = scheduledAt.toISOString()
        const [{ count }] = await sql`select count(*)::int as count from runs where scheduled_at = ${at}`
        await sql`insert into runs (scheduled_at, pid, event) values (${at}, ${process.pid}, 'start')`
        // The first process that runs this occurrence stops in the middle of the run, as a crash would.
        if (at === CRASH_AT && count === 0) process.kill(process.pid, "SIGKILL")
        await new Promise(resolve => setTimeout(resolve, 150))
        await sql`insert into runs (scheduled_at, pid, event) values (${at}, ${process.pid}, 'done')`
      },
    }),
  },
  // Each process has its own run history. Only the leases keep the processes apart.
  scheduleRunStore: createMemoryScheduleRunStore(),
})

process.once("SIGTERM", async () => {
  await controller.close()
  await sql.end()
  process.exit(0)
})
process.send?.("ready")
