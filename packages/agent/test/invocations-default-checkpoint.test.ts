import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"

const started = vi.hoisted(() => [] as string[])
vi.mock("../src/internal/sqlite-wal-checkpointer.ts", () => ({
  startWalCheckpointer: (path: string) => {
    started.push(path)
    return async () => {}
  },
}))

const { openDefaultLibsqlJournal } = await import("../src/invocations/default-libsql.ts")
const { createLibsqlAgentInvocationStore } = await import("../src/invocations/sqlite.ts")
const { createClient } = await import("@libsql/client")

let directory: string | undefined
afterEach(async () => {
  started.length = 0
  if (directory) await rm(directory, { force: true, recursive: true })
  directory = undefined
})

it("checkpoints the default journal file on a worker thread", async () => {
  directory = await mkdtemp(join(tmpdir(), "vitehub-journal-checkpoint-"))
  const file = join(directory, "journal.db")
  const { client, store } = await openDefaultLibsqlJournal({ file, url: `file:${file}` }, undefined)
  try {
    await store.list({})
    expect(started).toEqual([file])
  }
  finally {
    client.close()
  }
}, 30_000)

it("leaves a caller's client to its own checkpoints", async () => {
  directory = await mkdtemp(join(tmpdir(), "vitehub-journal-checkpoint-"))
  const file = join(directory, "journal.db")
  const client = createClient({ url: `file:${file}` })
  try {
    await createLibsqlAgentInvocationStore({ client }).list({})
    expect(started).toEqual([])
  }
  finally {
    client.close()
  }
}, 30_000)
