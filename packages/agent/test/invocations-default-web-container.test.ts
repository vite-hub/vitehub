import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import { afterEach, expect, it, vi } from "vitest"

vi.mock("@vite-hub/web-container/env", () => ({ isWebContainer: () => true }))
vi.mock("@libsql/client", async importOriginal => {
  const actual = await importOriginal<typeof import("@libsql/client")>()
  return { ...actual, createClient: vi.fn(actual.createClient) }
})

import { defineAgent, runAgent } from "../src/index.ts"
import { createDefaultAgentInvocations } from "../src/invocations/default.ts"

const tempDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

// The WASM build of @libsql/client that a WebContainer installs fails to open a file with SQLITE_CANTOPEN.
it.each([undefined, "1MB"])("keeps the default journal in a local file with SQLite WASM (maxSize: %s)", async (maxSize) => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.mocked(createClient).mockClear()
  const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-agent-journal-wasm-"))
  tempDirs.push(projectRoot)
  const invocations = createDefaultAgentInvocations({ env: {}, projectRoot, retention: maxSize ? { maxSize } : {} })

  const [error, result] = await runAgent(defineAgent({ driver: { run: () => "Hello, Ada." }, invocations, runtime: false }), {})

  expect(error).toBeFalsy()
  expect(result?.text).toBe("Hello, Ada.")
  await expect(invocations.list()).resolves.toMatchObject({ invocations: [{ status: "completed" }] })
  if (maxSize) await expect(invocations.prune({ dryRun: true })).resolves.toMatchObject({ size: { budgetBytes: 1024 ** 2 } })
  expect(createClient).not.toHaveBeenCalled()
  const native = createClient({ url: `file:${join(projectRoot, ".vitehub/data/agent-invocations.sqlite")}` })
  try {
    expect((await native.execute("SELECT status FROM vitehub_agent_invocations")).rows.map(row => row.status)).toEqual(["completed"])
  }
  finally {
    native.close()
  }
})

it("rejects size retention for a WASM journal opened in memory", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-agent-journal-wasm-"))
  tempDirs.push(projectRoot)
  const invocations = createDefaultAgentInvocations({ databaseUrl: "file:journal.sqlite?mode=memory", env: {}, projectRoot, retention: { maxSize: "1MB" } })

  await expect(invocations.list()).rejects.toMatchObject({ code: "AGENT_R0632" })
})
