import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { runAgentInvocationsCli } from "../src/internal/agent-invocations-cli.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"

import type { AgentInvocationStore, AgentInvocationStoreCreateInput } from "../src/invocations.ts"

vi.mock("@libsql/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@libsql/client")>()
  return { ...original, createClient: vi.fn(original.createClient) }
})

const day = 24 * 60 * 60 * 1000
const ago = (milliseconds: number) => new Date(Date.now() - milliseconds).toISOString()
const invocation = (id: string, status: AgentInvocationStoreCreateInput["status"], updatedAt = ago(0)): AgentInvocationStoreCreateInput => ({
  createdAt: updatedAt,
  id,
  observations: [],
  status,
  traceId: `trace:${id}`,
  updatedAt,
})

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-invocation-deletion-"))
  directories.push(directory)
  return directory
}

async function seed(store: AgentInvocationStore) {
  await store.create(invocation("old-completed", "completed", ago(40 * day)))
  await store.create(invocation("old-failed", "failed", ago(35 * day)))
  await store.create(invocation("old-running", "running", ago(40 * day)))
  await store.create(invocation("recent-cancelled", "cancelled", ago(day)))
}

const stores = {
  libsql: async () => {
    const directory = await temporaryDirectory()
    return createLibsqlAgentInvocationStore({ maxAgeMs: false, maxRecords: false, url: `file:${join(directory, "journal.sqlite")}` })
  },
  memory: async () => createMemoryAgentInvocationStore(),
}

describe.each(Object.entries(stores))("%s Agent Invocation deletion", (_name, createStore) => {
  it("deletes only terminal records and reports missing and active records", async () => {
    const store = await createStore()
    const invocations = defineAgentInvocations({ store })
    await seed(store)

    await expect(invocations.delete("old-completed")).resolves.toBe("deleted")
    await expect(invocations.delete("old-completed")).resolves.toBe("not-found")
    expect(invocations.supportsDelete).toBe(true)
    await expect(invocations.delete("old-running")).resolves.toBe("not-terminal")
    await expect(invocations.get("old-completed")).resolves.toBeUndefined()
    await expect(invocations.get("old-running")).resolves.toMatchObject({ status: "running" })
  })

  it("prunes terminal records older than a cutoff and previews them with dryRun", async () => {
    const store = await createStore()
    const invocations = defineAgentInvocations({ store })
    await seed(store)

    const preview = await invocations.prune({ dryRun: true, olderThanMs: 30 * day })
    expect(preview).toEqual({ dryRun: true, ids: expect.arrayContaining(["old-completed", "old-failed"]) })
    expect(preview.ids).toHaveLength(2)
    await expect(invocations.get("old-completed")).resolves.toBeDefined()

    const pruned = await invocations.prune({ olderThanMs: 30 * day })
    expect(pruned.dryRun).toBe(false)
    expect([...pruned.ids].sort()).toEqual(["old-completed", "old-failed"])
    const remaining = (await invocations.list()).invocations.map(record => record.id).sort()
    expect(remaining).toEqual(["old-running", "recent-cancelled"])
  })

  it("rejects an invalid prune age", async () => {
    const invocations = defineAgentInvocations({ store: await createStore() })
    await expect(invocations.prune({ olderThanMs: -1 })).rejects.toThrow("olderThanMs must be a non-negative safe integer")
    await expect(invocations.prune({ olderThanMs: 1.5 })).rejects.toThrow("olderThanMs must be a non-negative safe integer")
    await expect(invocations.prune({ olderThanMs: 8_700_000_000_000_000 })).rejects.toMatchObject({ code: "AGENT_R0929" })
  })
})

describe("Agent Invocation retention", () => {
  it("accepts the earliest representable cutoff and rejects ages beyond it without pruning", async () => {
    vi.spyOn(Date, "now").mockReturnValue(0)
    const store = createMemoryAgentInvocationStore()
    const prune = vi.spyOn(store, "prune")
    const invocations = defineAgentInvocations({ store })

    await expect(invocations.prune({ olderThanMs: 8_640_000_000_000_000 })).resolves.toEqual({ dryRun: false, ids: [] })
    expect(prune).toHaveBeenCalledWith({ updatedBefore: "-271821-04-20T00:00:00.000Z" })
    prune.mockClear()

    await expect(invocations.prune({ olderThanMs: 8_640_000_000_000_001 })).rejects.toMatchObject({ code: "AGENT_R0929" })
    expect(prune).not.toHaveBeenCalled()
  })

  it("keeps every record when the memory store prunes without a cutoff", async () => {
    const store = createMemoryAgentInvocationStore()
    await seed(store)
    await expect(defineAgentInvocations({ store }).prune()).resolves.toEqual({ dryRun: false, ids: [] })
  })

  it("applies the SQLite store's configured retention when prune has no cutoff", async () => {
    const directory = await temporaryDirectory()
    const url = `file:${join(directory, "journal.sqlite")}`
    await seed(createLibsqlAgentInvocationStore({ maxAgeMs: false, maxRecords: false, url }))
    const bounded = defineAgentInvocations({ store: createLibsqlAgentInvocationStore({ maxAgeMs: 30 * day, maxRecords: false, url }) })

    expect([...(await bounded.prune({ dryRun: true })).ids].sort()).toEqual(["old-completed", "old-failed"])
    expect([...(await bounded.prune()).ids].sort()).toEqual(["old-completed", "old-failed"])

    const counted = defineAgentInvocations({ store: createLibsqlAgentInvocationStore({ maxAgeMs: false, maxRecords: 1, url }) })
    await counted.prune()
    const remaining = (await counted.list()).invocations.map(record => record.id).sort()
    expect(remaining).toEqual(["old-running", "recent-cancelled"])
  })

  it("removes the SQLite claim row with the deleted record", async () => {
    const directory = await temporaryDirectory()
    const client = createClient({ url: `file:${join(directory, "journal.sqlite")}` })
    try {
      const store = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false })
      await store.create(invocation("claimed", "completed"))
      expect(await store.claim("claimed", "owner", 30_000)).toBe(true)
      expect((await client.execute("SELECT id FROM vitehub_agent_invocations_claims")).rows).toHaveLength(1)

      await expect(store.delete!("claimed")).resolves.toBe("deleted")
      expect((await client.execute("SELECT id FROM vitehub_agent_invocations_claims")).rows).toHaveLength(0)
    }
    finally {
      client.close()
    }
  })

  it("reports a store without delete or prune support", async () => {
    const { delete: _delete, prune: _prune, ...store } = createMemoryAgentInvocationStore()
    const invocations = defineAgentInvocations({ store })
    expect(invocations.supportsDelete).toBe(false)
    await expect(invocations.delete("missing")).rejects.toMatchObject({ code: "AGENT_R0932" })
    await expect(invocations.delete("missing")).rejects.toThrow("does not support deletion")
    await expect(invocations.prune()).rejects.toMatchObject({ code: "AGENT_R0932" })
    await expect(invocations.prune()).rejects.toThrow("does not support pruning")
  })
})

describe("vitehub agent invocations delete and prune", () => {
  function output() {
    const chunks = { stderr: "", stdout: "" }
    return {
      chunks,
      stderr: { write: (chunk: string | Uint8Array) => { chunks.stderr += String(chunk) } },
      stdout: { write: (chunk: string | Uint8Array) => { chunks.stdout += String(chunk) } },
    }
  }

  async function consoleJournal() {
    const rootDir = await temporaryDirectory()
    await mkdir(join(rootDir, ".vitehub/data"), { recursive: true })
    const url = `file:${join(rootDir, ".vitehub/data/console.sqlite")}`
    await seed(createLibsqlAgentInvocationStore({ maxAgeMs: false, maxRecords: false, url }))
    const read = defineAgentInvocations({ store: createLibsqlAgentInvocationStore({ maxAgeMs: false, maxRecords: false, url }) })
    return { read, rootDir }
  }

  it("deletes a terminal record from the default Console journal", async () => {
    const { read, rootDir } = await consoleJournal()
    const io = output()

    await expect(runAgentInvocationsCli(["delete", "old-completed"], { env: {}, rootDir, ...io })).resolves.toBe(0)
    expect(io.chunks.stdout).toBe("Deleted old-completed.\n")
    await expect(read.get("old-completed")).resolves.toBeUndefined()

    const json = output()
    await expect(runAgentInvocationsCli(["delete", "old-running", "--json"], { env: {}, rootDir, ...json })).resolves.toBe(1)
    expect(JSON.parse(json.chunks.stdout)).toEqual({ id: "old-running", outcome: "not-terminal" })

    const missing = output()
    await expect(runAgentInvocationsCli(["delete", "old-completed"], { env: {}, rootDir, ...missing })).resolves.toBe(1)
    expect(missing.chunks.stderr).toBe("Agent Invocation old-completed was not found.\n")
  })

  it("previews and prunes terminal records older than the requested age", async () => {
    const { read, rootDir } = await consoleJournal()
    const preview = output()

    await expect(runAgentInvocationsCli(["prune", "--older-than", "30d", "--dry-run", "--json"], { env: {}, rootDir, ...preview })).resolves.toBe(0)
    const planned = JSON.parse(preview.chunks.stdout)
    expect(planned).toMatchObject({ dryRun: true, olderThanMs: 30 * day })
    expect([...planned.ids].sort()).toEqual(["old-completed", "old-failed"])
    expect((await read.list()).invocations).toHaveLength(4)

    const pruned = output()
    await expect(runAgentInvocationsCli(["prune", "--older-than=36d"], { env: {}, rootDir, ...pruned })).resolves.toBe(0)
    expect(pruned.chunks.stdout).toMatch(/^old-completed\nDeleted 1 terminal Agent Invocation last updated before \S+\.\n$/)
    expect((await read.list()).invocations.map(record => record.id).sort()).toEqual(["old-failed", "old-running", "recent-cancelled"])
  })

  it("uses an explicit database path and rejects a missing journal without creating it", async () => {
    const { read, rootDir } = await consoleJournal()
    const elsewhere = await temporaryDirectory()
    const explicit = output()
    await expect(runAgentInvocationsCli(["prune", "--database", join(rootDir, ".vitehub/data/console.sqlite"), "--json"], { env: {}, rootDir: elsewhere, ...explicit })).resolves.toBe(0)
    expect([...JSON.parse(explicit.chunks.stdout).ids].sort()).toEqual(["old-completed", "old-failed"])
    expect((await read.list()).invocations).toHaveLength(2)

    const missing = output()
    await expect(runAgentInvocationsCli(["prune"], { env: {}, rootDir: elsewhere, ...missing })).resolves.toBe(1)
    expect(missing.chunks.stderr).toContain(`No Agent Invocation journal exists at ${join(elsewhere, ".vitehub/data/console.sqlite")}`)
  })

  it("resolves the default journal from the ViteHub project root", async () => {
    const projectRoot = await temporaryDirectory()
    const appRoot = join(projectRoot, "app")
    await mkdir(join(projectRoot, "server", "agents"), { recursive: true })
    await mkdir(appRoot)
    await mkdir(join(projectRoot, ".vitehub/data"), { recursive: true })
    const url = `file:${join(projectRoot, ".vitehub/data/console.sqlite")}`
    await seed(createLibsqlAgentInvocationStore({ maxAgeMs: false, maxRecords: false, url }))
    const io = output()

    await expect(runAgentInvocationsCli(["delete", "old-completed"], { env: {}, rootDir: appRoot, ...io })).resolves.toBe(0)
    expect(io.chunks.stdout).toBe("Deleted old-completed.\n")
  })

  it("rejects invalid durations and extra arguments", async () => {
    const duration = output()
    await expect(runAgentInvocationsCli(["prune", "--older-than", "soon"], { env: {}, ...duration })).resolves.toBe(1)
    expect(duration.chunks.stderr).toContain("--older-than requires a duration such as 90m, 12h, or 30d.")

    const extra = output()
    await expect(runAgentInvocationsCli(["prune", "old-completed"], { env: {}, ...extra })).resolves.toBe(1)
    expect(extra.chunks.stderr).toContain("Unexpected argument: old-completed.")

    const id = output()
    await expect(runAgentInvocationsCli(["delete"], { env: {}, ...id })).resolves.toBe(1)
    expect(id.chunks.stderr).toContain("delete requires an invocation id.")
  })

  it("rejects dry-run for delete without opening the journal", async () => {
    const { read, rootDir } = await consoleJournal()
    const io = output()
    vi.mocked(createClient).mockClear()

    await expect(runAgentInvocationsCli(["delete", "old-completed", "--dry-run"], { env: {}, rootDir, ...io })).resolves.toBe(1)
    expect(io.chunks.stderr).toContain("--dry-run is only supported for prune.")
    expect(io.chunks.stdout).toContain("Usage: vitehub agent invocations")
    expect(createClient).not.toHaveBeenCalled()
    await expect(read.get("old-completed")).resolves.toMatchObject({ status: "completed" })
  })

  it("rejects prune durations outside the Date range without changing the journal", async () => {
    const { read, rootDir } = await consoleJournal()
    const io = output()

    await expect(runAgentInvocationsCli(["prune", "--older-than", "8700000000000000ms"], { env: {}, rootDir, ...io })).resolves.toBe(1)
    expect(io.chunks.stderr).toContain("--older-than must produce a cutoff within JavaScript's Date range.")
    expect(io.chunks.stderr).not.toContain("Invalid time value")
    expect(io.chunks.stdout).toBe("")
    expect((await read.list()).invocations).toHaveLength(4)
  })

  it("redacts credentialed URLs in parse errors", async () => {
    const io = output()
    await expect(runAgentInvocationsCli(["prune", "--database-url=libsql://user:password@host/db?authToken=secret"], { env: {}, ...io })).resolves.toBe(1)
    expect(io.chunks.stderr).toContain("Unknown option: --database-url=libsql://host/db.")
    expect(io.chunks.stderr).not.toMatch(/password|secret/)
  })

  it.each([
    ["file:./journal.sqlite?authToken=secret", "file:///journal.sqlite"],
    ["file:./journal.sqlite?authToken=secret#fragment-secret", "file:///journal.sqlite"],
    ["custom+store.v1:journal?authToken=secret#fragment-secret", "custom+store.v1:journal"],
  ])("redacts %s in misspelled options and unexpected positional arguments", async (url, redactedUrl) => {
    const option = output()
    await expect(runAgentInvocationsCli(["prune", `--databse=${url}`], { env: {}, ...option })).resolves.toBe(1)
    expect(option.chunks.stderr).toContain(`Unknown option: --databse=${redactedUrl}.`)
    expect(`${option.chunks.stdout}${option.chunks.stderr}`).not.toContain("secret")

    const positional = output()
    await expect(runAgentInvocationsCli(["prune", url], { env: {}, ...positional })).resolves.toBe(1)
    expect(positional.chunks.stderr).toContain(`Unexpected argument: ${redactedUrl}.`)
    expect(`${positional.chunks.stdout}${positional.chunks.stderr}`).not.toContain("secret")
  })

  it.each([
    { source: "explicit", agentToken: "agent-secret", consoleToken: "console-secret", expectedToken: "agent-secret" },
    { source: "explicit", agentToken: undefined, consoleToken: "console-secret", expectedToken: undefined },
    { source: "agent", agentToken: "agent-secret", consoleToken: "console-secret", expectedToken: "agent-secret" },
    { source: "agent", agentToken: undefined, consoleToken: "console-secret", expectedToken: undefined },
    { source: "console", agentToken: "agent-secret", consoleToken: "console-secret", expectedToken: "console-secret" },
    { source: "console", agentToken: "agent-secret", consoleToken: undefined, expectedToken: undefined },
    { source: "local", agentToken: "agent-secret", consoleToken: "console-secret", expectedToken: "console-secret" },
    { source: "local", agentToken: "agent-secret", consoleToken: undefined, expectedToken: undefined },
  ])("binds $source journal credentials with Agent token $agentToken and Console token $consoleToken", async ({ source, agentToken, consoleToken, expectedToken }) => {
    const rootDir = await temporaryDirectory()
    const localDirectory = join(rootDir, ".vitehub/data")
    await mkdir(localDirectory, { recursive: true })
    const localPath = join(localDirectory, "console.sqlite")
    const localClient = createClient({ url: `file:${localPath}` })
    await localClient.execute("SELECT 1")
    localClient.close()

    const explicitUrl = "https://explicit.example.com"
    const agentUrl = "https://agent.example.com"
    const consoleUrl = "https://console.example.com"
    const expectedUrl = source === "explicit" ? explicitUrl : source === "agent" ? agentUrl : source === "console" ? consoleUrl : `file://${localPath}`
    vi.mocked(createClient).mockImplementationOnce(() => { throw new Error("Database client creation intercepted") })
    const io = output()
    const code = await runAgentInvocationsCli(["prune", ...(source === "explicit" ? ["--database", explicitUrl] : [])], {
      env: {
        ...(source === "explicit" || source === "agent" ? { VITEHUB_AGENT_INVOCATIONS_DATABASE_URL: agentUrl } : {}),
        ...(source !== "local" ? { VITEHUB_CONSOLE_DATABASE_URL: consoleUrl } : {}),
        ...(agentToken ? { VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN: agentToken } : {}),
        ...(consoleToken ? { VITEHUB_CONSOLE_DATABASE_AUTH_TOKEN: consoleToken } : {}),
      },
      rootDir,
      ...io,
    })
    expect(code).toBe(1)
    expect(io.chunks.stderr).toContain("Database client creation intercepted")
    expect(createClient).toHaveBeenLastCalledWith({ url: expectedUrl, ...(expectedToken ? { authToken: expectedToken } : {}) })
  })

  it("does not print the remote database credentials", async () => {
    const io = output()
    const code = await runAgentInvocationsCli(["prune", "--database", "http://user:url-secret@127.0.0.1:9/journal?authToken=query-secret"], {
      env: { VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN: "token-secret" },
      ...io,
    })
    expect(code).toBe(1)
    const printed = `${io.chunks.stdout}${io.chunks.stderr}`
    expect(printed).not.toMatch(/url-secret|query-secret|token-secret/)
  })
})
