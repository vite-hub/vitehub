import { chmod, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"

import { runAgentInvocationsCli } from "../src/internal/agent-invocations-cli.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"

import type { AgentInvocationStoreCreateInput } from "../src/invocations.ts"

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

const directories: string[] = []
afterEach(async () => {
  vi.doUnmock("node:sqlite")
  vi.resetModules()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-invocation-journal-file-"))
  directories.push(directory)
  return directory
}

const observation = (sequence: number, name: string) => ({ name, sequence, timestamp: `2026-10-06T10:00:0${sequence}.000Z`, type: "run" as const })

function invocation(id: string, status: AgentInvocationStoreCreateInput["status"], observations = [observation(1, "agent.invocation.start")]): AgentInvocationStoreCreateInput {
  return { agentName: "support", createdAt: "2026-10-06T10:00:00.000Z", id, observations, status, traceId: `trace-${id}`, updatedAt: "2026-10-06T10:01:00.000Z" }
}

/** A journal written by the SQLite store. The running record keeps its appended observation in the observations table. */
async function storeJournal() {
  const path = join(await temporaryDirectory(), "console.sqlite")
  const store = createLibsqlAgentInvocationStore({ maxAge: false, maxRecords: false, url: `file:${path}` })
  await store.create(invocation("first", "completed"))
  await store.create(invocation("second", "running"))
  await store.update("second", { appendObservation: { attributes: { "vitehub.observation.id": "obs-2" }, name: "agent.message.delta", timestamp: "2026-10-06T10:00:02.000Z", type: "run" }, timestamp: "2026-10-06T10:01:00.000Z" })
  const appended = new DatabaseSync(path, { readOnly: true })
  expect(appended.prepare("SELECT COUNT(*) AS count FROM vitehub_agent_invocations_observations").get()?.count).toBe(1)
  appended.close()
  return path
}

async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const stdout = stream()
  const stderr = stream()
  const fetch = vi.fn()
  // SAFETY: The mock only proves that a journal file read sends no request.
  const exitCode = await runAgentInvocationsCli(args, { env, stderr, stdout }, { fetch: fetch as unknown as typeof globalThis.fetch, sleep: async () => undefined })
  expect(fetch).not.toHaveBeenCalled()
  return { exitCode, stderr: stderr.output(), stdout: stdout.output() }
}

describe("vitehub agent invocations --database", () => {
  it("lists a store journal newest first and filters by status", async () => {
    const path = await storeJournal()
    const all = await run(["list", "--database", path, "--json"])
    expect(all.exitCode).toBe(0)
    expect(JSON.parse(all.stdout).invocations.map((record: { id: string }) => record.id)).toEqual(["second", "first"])

    const running = await run(["list", "--database", `file:${path}`, "--status", "running"])
    expect(running.stdout).toBe("second running 2026-10-06T10:01:00.000Z\n")

    const page = await run(["list", "--database", path, "--limit", "1", "--json"])
    expect(JSON.parse(page.stdout)).toMatchObject({ cursor: expect.any(String), invocations: [{ id: "second" }] })
  })

  it("shows a running record with its inline and appended observations", async () => {
    const path = await storeJournal()
    const result = await run(["show", "second", "--database", path, "--json"])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: "second",
      observations: [{ name: "agent.invocation.start", sequence: 1 }, { name: "agent.message.delta", sequence: 2 }],
      status: "running",
    })
  })

  it("tails a finished record from the file", async () => {
    const path = await storeJournal()
    const result = await run(["tail", "first", "--database", path])
    expect(result).toMatchObject({ exitCode: 0, stdout: "1 2026-10-06T10:00:01.000Z agent.invocation.start\n" })
  })

  it("reads an older read-only journal without migrating it", async () => {
    const path = join(await temporaryDirectory(), "journal.sqlite")
    const db = new DatabaseSync(path)
    db.exec("CREATE TABLE custom_invocations (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, record TEXT NOT NULL)")
    db.prepare("INSERT INTO custom_invocations (id, status, record) VALUES (?, ?, ?)").run("old", "failed", JSON.stringify(invocation("old", "failed")))
    db.close()
    await chmod(path, 0o444)
    const before = await readFile(path)

    expect((await run(["list", "--database", path, "--table-prefix", "custom_"])).stdout).toBe("old failed 2026-10-06T10:01:00.000Z\n")
    const shown = await run(["show", "old", "--database", path, "--table-prefix", "custom_", "--json"])
    expect(JSON.parse(shown.stdout)).toMatchObject({ id: "old", observations: [{ name: "agent.invocation.start" }] })
    expect((await readFile(path)).equals(before)).toBe(true)
  })

  it.each([
    [["list", "--database", "missing.sqlite"], "No Agent Invocation journal exists at"],
    [["list", "--database", "libsql://journal.example.com"], "--database for list, show, and tail reads a local SQLite file. Use --url for a deployed app."],
    [["list", "--database", "journal.sqlite", "--url", "http://localhost:5173/api/invocations"], "Pass --url or --database, not both."],
    [["cancel", "ainv_1", "--database", "journal.sqlite"], "cancel needs the running app. Pass --url or --server instead of --database."],
    [["list", "--database", "journal.sqlite", "--status", "stuck"], "--status must be one of pending, running, completed, failed, cancelled."],
  ])("rejects %j", async (args, message) => {
    const result = await run(args)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(message)
  })

  it("reports a missing table and a missing record", async () => {
    const path = join(await temporaryDirectory(), "empty.sqlite")
    new DatabaseSync(path).close()
    expect((await run(["list", "--database", path])).stderr).toBe(`No Agent Invocation journal table vitehub_agent_invocations exists in ${path}.\n`)

    const journal = await storeJournal()
    expect((await run(["show", "unknown", "--database", journal])).stderr).toBe(`Agent Invocation unknown was not found in ${journal}.\n`)
  })

  it("explains that the runtime has no node:sqlite", async () => {
    const path = await storeJournal()
    vi.resetModules()
    vi.doMock("node:sqlite", () => {
      throw new Error("No such built-in module: node:sqlite")
    })
    const { runAgentInvocationsCli: runWithoutSqlite } = await import("../src/internal/agent-invocations-cli.ts")
    const stderr = stream()
    expect(await runWithoutSqlite(["list", "--database", path], { env: {}, stderr, stdout: stream() })).toBe(1)
    expect(stderr.output()).toBe("--database reads the journal with node:sqlite, which this runtime does not provide. Run the command with Node.js 24, or pass --url.\n")
  })
})
