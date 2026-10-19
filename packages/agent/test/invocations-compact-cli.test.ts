import { mkdtemp, rm, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { runAgentInvocationsCli } from "../src/internal/agent-invocations-cli.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"

vi.mock("@libsql/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@libsql/client")>()
  return { ...original, createClient: vi.fn(original.createClient) }
})

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

function output() {
  const chunks = { stderr: "", stdout: "" }
  return {
    chunks,
    stderr: { write: (chunk: string | Uint8Array) => { chunks.stderr += String(chunk) } },
    stdout: { write: (chunk: string | Uint8Array) => { chunks.stdout += String(chunk) } },
  }
}

const enoughSpace = async () => Number.MAX_SAFE_INTEGER

async function fileBytes(path: string) {
  return existsSync(path) ? (await stat(path)).size : 0
}

async function pragmas(path: string) {
  const client = createClient({ url: `file:${path}` })
  try {
    const value = async (name: string) => Number((await client.execute(`PRAGMA ${name}`)).rows[0]?.[name])
    return { autoVacuum: await value("auto_vacuum"), freelistCount: await value("freelist_count") }
  }
  finally {
    client.close()
  }
}

/** A journal file with auto_vacuum NONE and about 4 MB of free pages, like a journal created before size retention. */
async function journalWithFreePages() {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-invocations-compact-"))
  directories.push(directory)
  const path = join(directory, "journal.sqlite")
  const client = createClient({ url: `file:${path}` })
  // A table that exists before the store opens the file keeps auto_vacuum at NONE.
  await client.executeMultiple("PRAGMA journal_mode = WAL; CREATE TABLE padding (data BLOB);")
  const store = createLibsqlAgentInvocationStore({ maxAge: false, maxRecords: false, url: `file:${path}` })
  for (const id of ["first", "second"]) {
    const now = new Date().toISOString()
    await store.create({ createdAt: now, id, observations: [], status: "completed", traceId: `trace:${id}`, updatedAt: now })
  }
  await client.execute("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 64) INSERT INTO padding SELECT randomblob(65536) FROM n")
  await client.execute("DELETE FROM padding")
  client.close()
  return { path, store }
}

describe("vitehub agent invocations compact", () => {
  it("shrinks a journal with auto_vacuum NONE and sets auto_vacuum to INCREMENTAL", async () => {
    const { path, store } = await journalWithFreePages()
    expect(await pragmas(path)).toMatchObject({ autoVacuum: 0, freelistCount: expect.any(Number) })
    expect((await pragmas(path)).freelistCount).toBeGreaterThan(900)
    const io = output()

    await expect(runAgentInvocationsCli(["compact", "--database", path, "--json"], { env: {}, ...io }, { freeSpace: enoughSpace })).resolves.toBe(0)

    const result = JSON.parse(io.chunks.stdout)
    const beforeBytes = result.before.fileBytes + result.before.walBytes
    expect(result).toMatchObject({ after: { autoVacuum: "incremental", freelistCount: 0, walBytes: 0 }, before: { autoVacuum: "none" }, database: path, dryRun: false, walTruncated: true })
    expect(result.before.freelistCount).toBeGreaterThan(900)
    expect(result.after.fileBytes).toBeLessThan(beforeBytes - 3 * 1024 * 1024)
    expect(result.after.fileBytes).toBe(result.after.liveBytes)
    expect(result.reclaimedBytes).toBe(beforeBytes - result.after.fileBytes)
    // VACUUM needs a temporary copy and a journal of the live data. Both can be on one volume or on two.
    const copyBytes = Math.ceil(result.before.liveBytes * 1.1)
    expect(result.space.volumes.reduce((total: number, volume: { requiredBytes: number }) => total + volume.requiredBytes, 0)).toBe(2 * copyBytes + result.before.walBytes)
    expect(await fileBytes(path)).toBe(result.after.fileBytes)
    expect(await pragmas(path)).toEqual({ autoVacuum: 2, freelistCount: 0 })
    await expect(store.get("first")).resolves.toMatchObject({ id: "first", status: "completed" })

    const text = output()
    await expect(runAgentInvocationsCli(["compact", "--database", path], { env: {}, ...text }, { freeSpace: enoughSpace })).resolves.toBe(0)
    expect(text.chunks.stdout).toContain(`Database: ${path}\n`)
    expect(text.chunks.stdout).toContain("auto_vacuum is now incremental.")
  })

  it("prints the measurements and the free space check in a dry run and changes nothing", async () => {
    const { path } = await journalWithFreePages()
    const before = { file: await fileBytes(path), wal: await fileBytes(`${path}-wal`), ...await pragmas(path) }
    const io = output()

    await expect(runAgentInvocationsCli(["compact", "--database", path, "--dry-run"], { env: {}, ...io }, { freeSpace: enoughSpace })).resolves.toBe(0)
    expect(io.chunks.stdout).toContain("auto_vacuum none.")
    expect(io.chunks.stdout).toContain("VACUUM shrinks the file to about this size.")
    expect(io.chunks.stdout).toContain("required, enough.")
    expect(io.chunks.stdout).toContain("Dry run: compact can run. Nothing changed.")

    const refused = output()
    await expect(runAgentInvocationsCli(["compact", "--database", path, "--dry-run", "--json"], { env: {}, ...refused }, { freeSpace: async () => 0 })).resolves.toBe(1)
    const result = JSON.parse(refused.chunks.stdout)
    expect(result).toMatchObject({ before: { autoVacuum: "none" }, dryRun: true, space: { ok: false } })
    expect(result.after).toBeUndefined()

    expect({ file: await fileBytes(path), wal: await fileBytes(`${path}-wal`), ...await pragmas(path) }).toEqual(before)
  })

  it("refuses to compact without enough free space and prints the requirement", async () => {
    const { path } = await journalWithFreePages()
    const io = output()

    await expect(runAgentInvocationsCli(["compact", "--database", path], { env: {}, ...io }, { freeSpace: async () => 1024 })).resolves.toBe(1)
    expect(io.chunks.stderr).toContain(`Not enough free space to compact ${path}.`)
    expect(io.chunks.stderr).toMatch(/1024 bytes available, \d+ bytes required\./)
    expect(await pragmas(path)).toMatchObject({ autoVacuum: 0 })
    expect((await pragmas(path)).freelistCount).toBeGreaterThan(900)
  })

  it("fails with a clear message when another connection holds the write lock", async () => {
    const { path } = await journalWithFreePages()
    const holder = createClient({ url: `file:${path}` })
    const transaction = await holder.transaction("write")
    try {
      await transaction.execute("INSERT INTO padding VALUES (x'00')")
      const io = output()
      await expect(runAgentInvocationsCli(["compact", "--database", path], { env: {}, ...io }, { compactBusyTimeoutMs: 100, freeSpace: enoughSpace })).resolves.toBe(1)
      expect(io.chunks.stderr).toContain(`${path} is busy.`)
      expect(io.chunks.stderr).toContain("Stop the server that uses the journal, or run compact during a quiet window.")
    }
    finally {
      await transaction.rollback()
      holder.close()
    }
    expect(await pragmas(path)).toMatchObject({ autoVacuum: 0 })
  })

  it.each([
    ["libsql://journal.example.com?authToken=secret-token", "is a remote libSQL database"],
    [":memory:", "An in-memory database has no file to compact."],
    ["file::memory:", "An in-memory database has no file to compact."],
  ])("rejects %s before it opens a client", async (database, message) => {
    vi.mocked(createClient).mockClear()
    const io = output()

    await expect(runAgentInvocationsCli(["compact", "--database", database], { env: {}, ...io }, { freeSpace: enoughSpace })).resolves.toBe(1)
    expect(io.chunks.stderr).toContain(message)
    expect(io.chunks.stderr).not.toContain("secret-token")
    expect(createClient).not.toHaveBeenCalled()
  })

  it("rejects --url and an invocation id", async () => {
    const url = output()
    await expect(runAgentInvocationsCli(["compact", "--url", "https://app.example.com"], { env: {}, ...url })).resolves.toBe(1)
    expect(url.chunks.stderr).toContain("compact rebuilds a local SQLite file. Pass --database with the file path instead of --url or --server.")

    const id = output()
    await expect(runAgentInvocationsCli(["compact", "first"], { env: {}, ...id })).resolves.toBe(1)
    expect(id.chunks.stderr).toContain("Unexpected argument: first.")
  })
})
