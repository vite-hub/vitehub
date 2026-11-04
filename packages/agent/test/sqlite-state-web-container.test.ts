import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { createClient } from "@libsql/client"
import { afterEach, expect, it, vi } from "vitest"

vi.mock("@vite-hub/web-container/env", () => ({ isWebContainer: () => true }))
vi.mock("@libsql/client", async importOriginal => {
  const actual = await importOriginal<typeof import("@libsql/client")>()
  return { ...actual, createClient: vi.fn(actual.createClient) }
})

import { createLibsqlAgentState } from "../src/state/sqlite.ts"

const tempDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

it("keeps Agent State in a local file with SQLite WASM in a WebContainer", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.mocked(createClient).mockClear()
  const dir = await mkdtemp(join(tmpdir(), "vitehub-agent-state-wasm-"))
  tempDirs.push(dir)
  const path = join(dir, ".vitehub", "data", "agent-state.sqlite")
  const first = createLibsqlAgentState({ url: `file:${path}` })
  const second = createLibsqlAgentState({ url: pathToFileURL(path).href.replace(/^file:/, "FILE:") })
  try {
    await first.connect()
    await second.connect()
    await Promise.all([first, second].map(async (state, index) => {
      for (let n = 0; n < 3; n++) await state.set(`writer-${index}-${n}`, { n })
    }))
    await expect(second.get("writer-0-2")).resolves.toEqual({ n: 2 })
    await expect(first.extension("probe").transaction(async () => {
      throw new Error("rollback probe")
    })).rejects.toThrow("rollback probe")
    await first.set("turn", 1)
  }
  finally {
    await first.disconnect()
    await second.disconnect()
  }
  expect(createClient).not.toHaveBeenCalled()

  // A new adapter, as after a dev server restart, reads the state from the file.
  const reopened = createLibsqlAgentState({ url: `file:${path}` })
  await reopened.connect()
  try {
    await expect(reopened.get("turn")).resolves.toBe(1)
    await expect(reopened.get("writer-1-1")).resolves.toEqual({ n: 1 })
  }
  finally {
    await reopened.disconnect()
  }
  const native = createClient({ url: `file:${path}` })
  expect((await native.execute("SELECT count(*) AS n FROM vitehub_agent_state_cache")).rows[0]!.n).toBeGreaterThan(0)
  native.close()
})
