import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { postgresAgentInvocationTables } from "../src/invocations/postgres.ts"
import { agentInvocationPostgresClient } from "../src/invocations/postgres-clients.ts"
import { createPostgresAgentInvocationStore } from "../src/invocations/postgres-store.ts"
import { agentProcessHostLeaseKey } from "../src/runtime/process-host-lease.ts"

import type { ChildProcess } from "node:child_process"

const url = process.env.VITEHUB_TEST_POSTGRES_URL
const fixture = fileURLToPath(new URL("./fixtures/process-host-lease-postgres.mjs", import.meta.url))
const tablePrefix = "vitehub_host_lease_"
const ttlMs = 3_000
const intervalMs = 500
const claimMs = 1_000
const agentName = `babysitter-${process.pid}`

vi.setConfig({ testTimeout: 60_000 })

interface Line { instance: string, at: number, ready?: boolean, started?: boolean, closed?: boolean, invocation?: string, handled?: string, delivered?: string, status?: number }

interface Server { name: string, process: ChildProcess, lines: Line[], next: (match: (line: Line) => boolean) => Promise<Line> }

describe.skipIf(!url)("one Agent process host across servers on a Postgres server", () => {
  const servers: Server[] = []
  let sql: ReturnType<typeof postgres>
  let rootDir: string
  const store = () => createPostgresAgentInvocationStore({ client: () => agentInvocationPostgresClient(sql, "default"), maxAge: false, maxRecords: false, tablePrefix })

  function start(name: string): Server {
    const child = spawn(process.execPath, ["--no-warnings", "--experimental-transform-types", fixture, url!, tablePrefix, agentName, join(rootDir, "state.db"), join(rootDir, "data"), String(ttlMs), String(intervalMs), String(claimMs)], {
      env: { ...process.env, VITEHUB_INSTANCE_ID: name },
      stdio: ["ignore", "pipe", "inherit", "ipc"],
    })
    const lines: Line[] = []
    const waiters: { match: (line: Line) => boolean, resolve: (line: Line) => void }[] = []
    createInterface({ input: child.stdout! }).on("line", (text) => {
      if (!text.startsWith("{")) return
      const line: Line = JSON.parse(text)
      lines.push(line)
      for (const waiter of waiters.filter(waiter => waiter.match(line))) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(line)
      }
    })
    const next = (match: (line: Line) => boolean) => new Promise<Line>((resolve, reject) => {
      const found = lines.find(match)
      if (found) return resolve(found)
      waiters.push({ match, resolve })
      child.once("exit", code => reject(new Error(`The server ${name} exited with ${code} before the expected line.`)))
    })
    const server = { name, process: child, lines, next }
    servers.push(server)
    return server
  }

  const running = (list: Server[]) => list.filter(server => server.lines.filter(line => line.started).length > server.lines.filter(line => line.closed).length)

  beforeAll(async () => {
    sql = postgres(url!, { max: 1, onnotice: () => {} })
    rootDir = await mkdtemp(join(tmpdir(), "vitehub-process-host-lease-"))
    await sql.unsafe(`DROP TABLE IF EXISTS ${tablePrefix}invocations_observations, ${tablePrefix}invocations`)
    await sql.unsafe(`DELETE FROM vitehub_leases WHERE key = '${agentProcessHostLeaseKey(agentName)}'`).catch(() => undefined)
    const migration = await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ ...postgresAgentInvocationTables({ tablePrefix }) }))
    for (const statement of migration) await sql.unsafe(statement)
  })

  afterAll(async () => {
    for (const server of servers) server.process.kill("SIGKILL")
    await sql.end()
    await rm(rootDir, { force: true, recursive: true })
  })

  it("runs one host, forwards deliveries to it, and fails over after the holder is killed", async () => {
    const all = [start("instance-a"), start("instance-b"), start("instance-c")]
    await Promise.all(all.map(server => server.next(line => line.ready === true)))
    await Promise.race(all.map(server => server.next(line => line.started === true)))
    await new Promise(resolve => setTimeout(resolve, 4 * intervalMs))
    expect(running(all)).toHaveLength(1)
    expect(all.flatMap(server => server.lines).filter(line => line.started)).toHaveLength(1)

    const [holder] = running(all)
    const standbys = all.filter(server => server !== holder)
    const inline = await holder!.next(line => line.invocation !== undefined)
    expect(await store().getSummary(inline.invocation!)).toMatchObject({ status: "running" })
    const [lease] = await sql.unsafe(`SELECT owner FROM vitehub_leases WHERE key = '${agentProcessHostLeaseKey(agentName)}'`)
    expect(lease).toMatchObject({ owner: holder!.name })

    standbys[0]!.process.send({ deliver: "delivery-1" })
    expect(await standbys[0]!.next(line => line.delivered === "delivery-1")).toMatchObject({ status: 202 })
    await holder!.next(line => line.handled === "delivery-1")

    holder!.process.kill("SIGKILL")
    const killedAt = Date.now()
    const takeover = await Promise.race(standbys.map(server => server.next(line => line.started === true)))
    const failoverMs = takeover.at - killedAt
    expect(failoverMs).toBeLessThan(ttlMs + intervalMs + 1_500)

    await new Promise(resolve => setTimeout(resolve, 4 * intervalMs))
    expect(running(standbys)).toHaveLength(1)
    expect(standbys.flatMap(server => server.lines).filter(line => line.started)).toHaveLength(1)
    const [next] = running(standbys)
    expect(next!.name).toBe(takeover.instance)

    await vi.waitFor(async () => expect(await store().getSummary(inline.invocation!)).toMatchObject({ status: "failed" }), { interval: 50, timeout: 5_000 })
    expect(standbys.flatMap(server => server.lines).filter(line => line.invocation === inline.invocation)).toEqual([])
    const nextInline = await next!.next(line => line.invocation !== undefined)
    expect(await store().getSummary(nextInline.invocation!)).toMatchObject({ status: "running" })

    const standby = standbys.find(server => server !== next)!
    standby.process.send({ deliver: "delivery-2" })
    await next!.next(line => line.handled === "delivery-2")
    process.stdout.write(`process host failover took ${failoverMs} ms with a ${ttlMs} ms Lease and a ${intervalMs} ms interval\n`)
  })
})
