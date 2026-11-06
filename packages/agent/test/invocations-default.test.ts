import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAgent, runAgent } from "../src/index.ts"
import { createDefaultAgentInvocations, defaultAgentInvocationsDatabase, resolveDefaultAgentInvocationsLocation } from "../src/invocations/default.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("default Agent Invocation journal", () => {
  it("resolves the default file, an explicit URL, D1, and the runtime env var", () => {
    const projectRoot = join(tmpdir(), "vitehub-default-journal-location")
    expect(resolveDefaultAgentInvocationsLocation({ env: {}, projectRoot })).toEqual({ url: pathToFileURL(join(projectRoot, ".vitehub/data/agent-invocations.sqlite")).href })
    expect(resolveDefaultAgentInvocationsLocation({ databaseUrl: "file:data/journal.sqlite", env: {}, projectRoot })).toEqual({ url: pathToFileURL(join(projectRoot, "data/journal.sqlite")).href })
    const d1 = { binding: "DB", env: () => ({}) }
    expect(resolveDefaultAgentInvocationsLocation({ d1, env: {}, projectRoot })).toEqual({ url: "d1:DB" })
    const env = { VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN: "token", VITEHUB_AGENT_INVOCATIONS_DATABASE_URL: "libsql://journal.example.com" }
    expect(resolveDefaultAgentInvocationsLocation({ d1, databaseUrl: "file:other.sqlite", env, projectRoot })).toEqual({ authToken: "token", url: "libsql://journal.example.com" })
  })

  it("keeps records in memory on a Worker without D1 or a remote URL", () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" })
    const invocations = createDefaultAgentInvocations({ env: {}, projectRoot: "/worker" })
    expect(defaultAgentInvocationsDatabase(invocations)).toBeUndefined()
  })

  it("records an Agent run with content in the local file on first use", { timeout: 30_000 }, async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-default-journal-"))
    try {
      const invocations = createDefaultAgentInvocations({ env: {}, projectRoot })
      const file = join(projectRoot, ".vitehub/data/agent-invocations.sqlite")
      expect(existsSync(file)).toBe(false)
      const agent = defineAgent({ driver: { run: () => "done" }, invocations, name: "support" })
      await runAgent(agent, { memo: vi.fn(), run: { runId: "default-journal" }, runtime: "unknown", waitUntil: vi.fn() }, { prompt: "Keep this prompt" })
      await vi.waitFor(async () => {
        await expect(invocations.getByRunId("default-journal", "support")).resolves.toMatchObject({ status: "completed" })
      })
      const record = await invocations.getByRunId("default-journal", "support")
      expect(JSON.stringify(record?.observations)).toContain("Keep this prompt")
      expect(existsSync(file)).toBe(true)
      expect(defaultAgentInvocationsDatabase(invocations)?.driver).toBe("libsql")
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })
})
