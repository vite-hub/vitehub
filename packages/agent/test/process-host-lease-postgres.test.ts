import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres"
import postgres from "postgres"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

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
const stateBackends = ["file", "postgres"] as const

vi.setConfig({ testTimeout: 60_000 })

interface Line { instance: string, at: number, ready?: boolean, started?: boolean, closed?: boolean, invocation?: string, handled?: string, delivered?: string, status?: number }

interface Server { name: string, process: ChildProcess, lines: Line[], next: (match: (line: Line) => boolean) => Promise<Line> }

describe.skipIf(!url)("one Agent process host across servers on a Postgres server", () => {
  const servers: Server[] = []
  let sql: ReturnType<typeof postgres>
  let rootDir: string
  const store = () => createPostgresAgentInvocationStore({ client: () => agentInvocationPostgresClient(sql, "default"), maxAge: false, maxRecords: false, tablePrefix })

  function start(name: string, agent: string, backend: typeof stateBackends[number]): Server {
    const state = backend === "postgres" ? "postgres" : join(rootDir, `${agent}.db`)
    const child = spawn(process.execPath, ["--no-warnings", "--experimental-transform-types", fixture, url!, tablePrefix, agent, state, join(rootDir, agent), String(ttlMs), String(intervalMs), String(claimMs)], {
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
    for (const backend of stateBackends) {
      await sql.unsafe(`DELETE FROM vitehub_leases WHERE key = '${agentProcessHostLeaseKey(`${agentName}-${backend}`)}'`).catch(() => undefined)
    }
    const stateTables = await sql.unsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND starts_with(table_name, '${tablePrefix}state_')`)
    for (const { table_name } of stateTables) await sql.unsafe(`DROP TABLE IF EXISTS "${String(table_name)}"`)
    const migration = await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ ...postgresAgentInvocationTables({ tablePrefix }) }))
    for (const statement of migration) await sql.unsafe(statement)
  })

  afterEach(() => {
    for (const server of servers.splice(0)) server.process.kill("SIGKILL")
  })

  afterAll(async () => {
    await sql.end()
    await rm(rootDir, { force: true, recursive: true })
  })

  it.each(stateBackends)("runs one host, forwards deliveries to it through %s Agent State, and fails over after the holder is killed", async (backend) => {
    const agent = `${agentName}-${backend}`
    const all = ["instance-a", "instance-b", "instance-c"].map(name => start(name, agent, backend))
    await Promise.all(all.map(server => server.next(line => line.ready === true)))
    await Promise.race(all.map(server => server.next(line => line.started === true)))
    await new Promise(resolve => setTimeout(resolve, 4 * intervalMs))
    expect(running(all)).toHaveLength(1)
    expect(all.flatMap(server => server.lines).filter(line => line.started)).toHaveLength(1)

    const [holder] = running(all)
    const standbys = all.filter(server => server !== holder)
    const inline = await holder!.next(line => line.invocation !== undefined)
    expect(await store().getSummary(inline.invocation!)).toMatchObject({ status: "running" })
    const [lease] = await sql.unsafe(`SELECT owner FROM vitehub_leases WHERE key = '${agentProcessHostLeaseKey(agent)}'`)
    expect(lease).toMatchObject({ owner: holder!.name })

    const senders = backend === "postgres" ? standbys : standbys.slice(0, 1)
    const deliveries = senders.map((standby, index) => ({ standby, id: `first-${index}` }))
    for (const { standby, id } of deliveries) standby.process.send({ deliver: id })
    for (const { standby, id } of deliveries) {
      expect(await standby.next(line => line.delivered === id)).toMatchObject({ status: 202 })
      await holder!.next(line => line.handled === id)
    }

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
    process.stdout.write(`process host failover on ${backend} Agent State took ${failoverMs} ms with a ${ttlMs} ms Lease and a ${intervalMs} ms interval\n`)
  })
})
