import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { runAgentInvocationsCli } from "../src/internal/agent-invocations-cli.ts"
import { postgresAgentInvocationTables } from "../src/invocations/postgres.ts"
import { defaultAgentJournalPostgresPrefix } from "../src/invocations/postgres-table-names.ts"
import { agentInvocationPostgresClient } from "../src/invocations/postgres-clients.ts"
import { createPostgresAgentInvocationStore } from "../src/invocations/postgres-store.ts"

import type { ChildProcess } from "node:child_process"

const url = process.env.VITEHUB_TEST_POSTGRES_URL
const fixture = fileURLToPath(new URL("./fixtures/recovery-sweep-postgres.mjs", import.meta.url))
const claimMs = 2_000
const intervalMs = 500
const agentName = `recovery-${process.pid}`

vi.setConfig({ testTimeout: 30_000 })

interface Line { instance: string, id?: string, claimId?: string, ready?: boolean, swept?: boolean, failed?: number, at?: number, error?: string, stopped?: boolean }

interface Child { process: ChildProcess, lines: Line[], next: (match: (line: Line) => boolean) => Promise<Line> }

function start(role: "run" | "sweep", children: Child[], env: Record<string, string> = {}): Child {
  const child = spawn(process.execPath, ["--no-warnings", "--experimental-transform-types", fixture, role, url!, defaultAgentJournalPostgresPrefix, agentName, String(claimMs), String(intervalMs)], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  })
  const lines: Line[] = []
  const waiters: { match: (line: Line) => boolean, resolve: (line: Line) => void }[] = []
  createInterface({ input: child.stdout! }).on("line", (text) => {
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
    child.once("exit", code => reject(new Error(`The ${role} process exited with ${code} before the expected line.`)))
  })
  const started = { lines, next, process: child }
  children.push(started)
  return started
}

function stream() {
  let value = ""
  return {
    output: () => value,
    write(chunk: string | Uint8Array) {
      value += String(chunk)
      return true
    },
  }
}

describe.skipIf(!url)("Agent recovery sweep on a Postgres server", () => {
  const children: Child[] = []
  let sql: ReturnType<typeof postgres>
  let rootDir: string
  const store = () => createPostgresAgentInvocationStore({ client: () => agentInvocationPostgresClient(sql, "default"), maxAge: false, maxRecords: false, tablePrefix: defaultAgentJournalPostgresPrefix })

  beforeAll(async () => {
    sql = postgres(url!, { max: 1, onnotice: () => {} })
    rootDir = await mkdtemp(join(tmpdir(), "vitehub-recovery-sweep-"))
    await writeFile(join(rootDir, "package.json"), JSON.stringify({ dependencies: { postgres: "*" }, private: true }))
    await mkdir(join(rootDir, "node_modules"))
    await symlink(fileURLToPath(new URL("../node_modules/postgres", import.meta.url)), join(rootDir, "node_modules/postgres"), "dir")
    await sql.unsafe(`DROP TABLE IF EXISTS ${defaultAgentJournalPostgresPrefix}invocations_observations, ${defaultAgentJournalPostgresPrefix}invocations`)
    await sql.unsafe(`DELETE FROM vitehub_leases WHERE key = 'agent-recovery:${agentName}'`).catch(() => undefined)
    const migration = await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ ...postgresAgentInvocationTables({ tablePrefix: defaultAgentJournalPostgresPrefix }) }))
    for (const statement of migration) await sql.unsafe(statement)
  })

  afterAll(async () => {
    for (const child of children) child.process.kill("SIGKILL")
    await sql.end()
    await rm(rootDir, { force: true, recursive: true })
  })

  it("fails the Invocation of a killed process within one sweep interval, with one sweeper at a time", async () => {
    const a = start("run", children, { VITEHUB_INSTANCE_ID: "instance-a" })
    const running = await a.next(line => line.id !== undefined)
    expect(running.claimId).toMatch(/^instance-a\//)
    const [b, c] = [start("sweep", children, { VITEHUB_INSTANCE_ID: "instance-b" }), start("sweep", children, { VITEHUB_INSTANCE_ID: "instance-c" })]
    await Promise.all([b.next(line => line.ready === true), c.next(line => line.ready === true)])

    await new Promise(resolve => setTimeout(resolve, 3 * intervalMs))
    expect(await store().getSummary(running.id!)).toMatchObject({ status: "running" })

    a.process.kill("SIGKILL")
    const killedAt = Date.now()
    await vi.waitFor(async () => expect(await store().getSummary(running.id!)).toMatchObject({ status: "failed" }), { interval: 50, timeout: claimMs + 4 * intervalMs })
    const recoveredAfterMs = Date.now() - killedAt
    expect(recoveredAfterMs).toBeLessThan(claimMs + intervalMs + 500)

    await vi.waitFor(() => expect([...b.lines, ...c.lines].reduce((total, line) => total + (line.failed ?? 0), 0)).toBe(1), { interval: 20, timeout: 2_000 })
    const sweepers = new Set([...b.lines, ...c.lines].filter(line => line.swept).map(line => line.instance))
    expect(sweepers.size).toBe(1)
    expect([...b.lines, ...c.lines].filter(line => line.error)).toEqual([])

    const [holder, other] = sweepers.has("instance-b") ? [b, c] : [c, b]
    holder.process.kill("SIGTERM")
    await holder.next(line => line.stopped === true)
    const before = other.lines.length
    await other.next(line => line.swept === true && other.lines.indexOf(line) >= before)

    const stdout = stream()
    const stderr = stream()
    const exitCode = await runAgentInvocationsCli(["list", "--json"], {
      env: {},
      journalPostgres: async () => ({ url: url! }),
      rootDir,
      stderr,
      stdout,
    })
    expect(stderr.output()).toBe("")
    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout.output())).toMatchObject({ invocations: [expect.objectContaining({ agentName, id: running.id, status: "failed" })] })
  })
})
