import { mkdtemp, readFile, rm } from "node:fs/promises"
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
})
