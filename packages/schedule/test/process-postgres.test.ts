import { fork } from "node:child_process"
import { fileURLToPath } from "node:url"

import postgres from "postgres"
import { afterAll, describe, expect, it } from "vitest"

import type { ChildProcess } from "node:child_process"

// Start Postgres 17, for example with `docker run -d -e POSTGRES_PASSWORD=pg -p 5432:5432 postgres:17`, and set
// VITEHUB_TEST_POSTGRES_URL to an empty database. The workers import the built package, so build it first.
const postgresUrl = process.env.VITEHUB_TEST_POSTGRES_URL
const worker = fileURLToPath(new URL("./fixtures/postgres-process.mjs", import.meta.url))
const minuteMs = 60_000
// One fake minute passes every two real seconds.
const speed = 30
const leaseTtlMs = 1500

interface RunRow {
  event: string
  pid: number
  scheduled_at: string
}

const children: ChildProcess[] = []
afterAll(() => {
  for (const child of children) child.kill("SIGKILL")
})

function start(env: Record<string, string>): Promise<ChildProcess> {
  const child = fork(worker, { env: { ...process.env, ...env }, stdio: ["ignore", "inherit", "inherit", "ipc"] })
  children.push(child)
  return new Promise((resolve, reject) => {
    child.once("message", () => resolve(child))
    child.once("exit", code => reject(new Error(`The worker stopped with code ${code} before it was ready.`)))
  })
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    child.once("exit", () => resolve())
    child.kill("SIGTERM")
  })
}

describe.skipIf(!postgresUrl)("Process Runtime on three processes with Postgres", () => {
  it("runs each occurrence once, and runs the occurrence of a crashed process again after its lease ends", async () => {
    const sql = postgres(postgresUrl!, { max: 1, onnotice: () => {} })
    try {
      await sql`drop table if exists runs`
      await sql`drop table if exists vitehub_leases`
      await sql`create table runs (scheduled_at text not null, pid int not null, event text not null, at timestamptz not null default clock_timestamp())`

      // The fake clock starts 10 seconds into a minute. The fourth minute is the one where a process crashes.
      const fakeStart = Date.parse("2026-11-09T08:00:10.000Z")
      const crashAt = new Date(Date.parse("2026-11-09T08:00:00.000Z") + 3 * minuteMs).toISOString()
      const env = { CRASH_AT: crashAt, DATABASE_URL: postgresUrl!, FAKE_START: String(fakeStart), LEASE_TTL_MS: String(leaseTtlMs), REAL_START: String(Date.now()), SPEED: String(speed) }
      const processes = await Promise.all([start(env), start(env), start(env)])

      // Run for about ten fake minutes.
      await new Promise(resolve => setTimeout(resolve, 20_000))
      await Promise.all(processes.map(stop))

      const rows = await sql<RunRow[]>`select scheduled_at, pid, event from runs order by at`
      const byMinute = new Map<string, RunRow[]>()
      for (const row of rows) byMinute.set(row.scheduled_at, [...byMinute.get(row.scheduled_at) ?? [], row])
      const minutes = [...byMinute.keys()].sort()
      // The last minute can be cut by the stop.
      const checked = minutes.slice(0, -1)

      expect(checked.length).toBeGreaterThanOrEqual(8)
      expect(checked[0]).toBe("2026-11-09T08:00:00.000Z")
      checked.forEach((minute, index) => expect(minute).toBe(new Date(Date.parse(checked[0]!) + index * minuteMs).toISOString()))
      for (const minute of checked) {
        const events = byMinute.get(minute)!
        if (minute === crashAt) continue
        expect(events.map(event => event.event), minute).toEqual(["start", "done"])
        expect(events[0]!.pid, minute).toBe(events[1]!.pid)
      }

      const crash = byMinute.get(crashAt)!
      expect(crash.map(event => event.event)).toEqual(["start", "start", "done"])
      const crashed = crash[0]!.pid
      expect(crash[1]!.pid).not.toBe(crashed)
      expect(crash[2]!.pid).toBe(crash[1]!.pid)
      expect(processes.filter(child => child.signalCode === "SIGKILL").map(child => child.pid)).toEqual([crashed])

      const [{ elapsed }] = await sql<{ elapsed: number }[]>`
        select extract(epoch from (max(at) filter (where event = 'start') - min(at))) * 1000 as elapsed
        from runs where scheduled_at = ${crashAt}`
      expect(Number(elapsed)).toBeGreaterThanOrEqual(leaseTtlMs - 100)
      // More than one process ran occurrences, so the test did not pass because one process did all the work.
      expect(new Set(rows.map(row => row.pid)).size).toBeGreaterThanOrEqual(2)
    }
    finally {
      await sql.end()
    }
  }, 60_000)
})
