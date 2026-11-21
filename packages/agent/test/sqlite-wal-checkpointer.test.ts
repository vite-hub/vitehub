import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { afterEach, expect, it } from "vitest"

import { startWalCheckpointer } from "../src/internal/sqlite-wal-checkpointer.ts"

let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { force: true, recursive: true })
  directory = undefined
})

// The WAL index header in the -shm file holds the WAL's last frame at byte 16.
const walFrames = async (path: string) => (await readFile(`${path}-shm`)).readUInt32LE(16)

it("checkpoints on a worker thread so the next commit restarts the WAL", async () => {
  directory = await mkdtemp(join(tmpdir(), "vitehub-wal-checkpoint-"))
  const path = join(directory, "state.db")
  const client = createClient({ url: `file:${path}` })
  await client.execute("PRAGMA journal_mode = WAL")
  await client.execute("CREATE TABLE rows (value TEXT)")
  for (let index = 0; index < 200; index++) await client.execute({ sql: "INSERT INTO rows VALUES (?)", args: ["x".repeat(3000)] })
  expect(await walFrames(path)).toBeGreaterThan(200)

  const stop = startWalCheckpointer(path, 20)
  expect(stop).toBeTypeOf("function")
  try {
    await expect.poll(async () => {
      await client.execute({ sql: "INSERT INTO rows VALUES (?)", args: ["y"] })
      return await walFrames(path)
    }, { interval: 50, timeout: 5_000 }).toBeLessThan(10)
    expect((await client.execute("SELECT count(*) AS count FROM rows")).rows[0]?.count).toBeGreaterThan(200)
  }
  finally {
    await stop?.()
    client.close()
  }
}, 30_000)

const checkpointerUrl = new URL("../src/internal/sqlite-wal-checkpointer.ts", import.meta.url).href
// Starts a 20 ms checkpointer in a child, keeps it busy long enough for the worker to spawn, then lets it end.
// The child runs a file: under --input-type=module the eval worker would inherit ESM and lose require().
async function runChild(flags: string[], directory: string) {
  const script = join(directory, "child.mjs")
  await writeFile(script, `import { startWalCheckpointer } from ${JSON.stringify(checkpointerUrl)}
startWalCheckpointer(${JSON.stringify(join(directory, "state.db"))}, 20)
setTimeout(() => console.log("done"), 300)
`)
  return spawnSync(process.execPath, [...flags, script], { encoding: "utf8", timeout: 10_000 })
}

it("lets the process exit while the worker runs", async () => {
  directory = await mkdtemp(join(tmpdir(), "vitehub-wal-checkpoint-"))
  const child = await runChild([], directory)
  expect(child.signal).toBeNull()
  expect(child.status).toBe(0)
  expect(child.stdout).toContain("done")
}, 30_000)

it("keeps commit checkpoints when the host refuses worker threads", async () => {
  directory = await mkdtemp(join(tmpdir(), "vitehub-wal-checkpoint-"))
  const child = await runChild(["--permission", "--allow-fs-read=*", "--allow-fs-write=*", "--allow-addons"], directory)
  expect(child.status).toBe(0)
  expect(child.stdout).toContain("done")
  expect(child.stderr).toMatch(/fell back to commits/)
}, 30_000)
