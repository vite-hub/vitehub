import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { createClient } from "@libsql/client"
import { afterAll, describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const fixture = fileURLToPath(new URL("./fixtures/local-sqlite-writer.ts", import.meta.url))
const roots: string[] = []
// Each write creates and deletes a journal file. On a busy disk that costs tens of milliseconds, so the file goes to
// tmpfs when the machine has one.
const tmpRoot = existsSync("/dev/shm") ? "/dev/shm" : tmpdir()

afterAll(async () => {
  await Promise.all(roots.map(dir => rm(dir, { force: true, recursive: true })))
})

interface WriterResult {
  errorCount: number
  errors: string[]
  pid: number
  written: number
}

describe("local libSQL client across processes", () => {
  it("keeps every write when four processes insert into one file at the same time", async () => {
    const dir = await mkdtemp(join(tmpRoot, "vitehub-local-sqlite-"))
    roots.push(dir)
    const file = join(dir, "app.db")
    const setup = createClient({ url: `file:${file}` })
    await setup.execute("create table writes (pid integer not null, n integer not null)")
    setup.close()

    // Without a busy timeout, this load gives SQLITE_BUSY errors, and libSQL drops writes that it reported as done.
    const writes = 300
    const startAt = Date.now() + 1500
    const outputs = await Promise.all(Array.from({ length: 4 }, () =>
      execFileAsync(process.execPath, [fixture, file, String(writes), String(startAt), "default"])))
    const results = outputs.map(({ stdout }): WriterResult => JSON.parse(stdout.trim().split("\n").at(-1)!))

    const check = createClient({ url: `file:${file}` })
    const { rows } = await check.execute("select pid, count(*) as count from writes group by pid")
    check.close()

    expect(results.map(result => result.errors)).toEqual([[], [], [], []])
    expect(results.map(result => result.written)).toEqual([writes, writes, writes, writes])
    expect(Object.fromEntries(rows.map(row => [Number(row.pid), Number(row.count)]))).toEqual(Object.fromEntries(results.map(result => [result.pid, writes])))
  }, 60_000)
})
