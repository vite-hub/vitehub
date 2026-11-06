import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { createClient } from "@libsql/client"
import { createLibsqlAgentInvocationStore } from "@vite-hub/agent/invocations/sqlite"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { createDefaultAgentInvocations } from "@vite-hub/agent/invocations/default"

import { installAgentInvocations, resolveDefaultAgentInvocations } from "../src/_internal/agent/invocations.ts"
import { agentInvocationsVitePlugin } from "../src/agent-invocations-vite.ts"
import { getConsoleUsageIndex } from "../src/console/runtime/server/invocations.ts"

import type { Client } from "@libsql/client"
import type { AgentInvocationStoreCreateInput, AgentRetentionPolicy } from "@vite-hub/agent/server"

const day = 24 * 60 * 60 * 1000
const ago = (milliseconds: number) => new Date(Date.now() - milliseconds).toISOString()
const finished = (id: string, updatedAt: string, status: AgentInvocationStoreCreateInput["status"] = "completed"): AgentInvocationStoreCreateInput => ({
  agentName: "bot",
  completedAt: updatedAt,
  createdAt: updatedAt,
  id,
  observations: [{
    attributes: { "usage.record": { cost: { estimated: false, usd: "0.01" }, usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } } },
    name: "agent.invocation.finish",
    sequence: 1,
    timestamp: updatedAt,
    type: "run",
  }],
  status,
  traceId: `trace:${id}`,
  updatedAt,
})

let directory: string
let url: string
const clients: Client[] = []

beforeAll(async () => {
  // Keep cold module loading outside the journal's one-second store operation timeout.
  await Promise.all([import("@libsql/client"), import("@vite-hub/agent/invocations/sqlite")])
})

beforeEach(async () => {
  vi.stubEnv("VITEHUB_AGENT_INVOCATIONS_DATABASE_URL", "")
  directory = await mkdtemp(join(tmpdir(), "vitehub-agent-retention-"))
  url = `file:${join(directory, "agent-invocations.sqlite")}`
  const seed = createLibsqlAgentInvocationStore({ maxAge: false, maxRecords: false, url })
  await seed.create(finished("old", ago(40 * day)))
  await seed.create(finished("recent", ago(day)))
  await seed.create({ ...finished("running", ago(40 * day)), status: "running" })
})

afterEach(async () => {
  installAgentInvocations({})
  for (const client of clients.splice(0)) client.close()
  vi.unstubAllEnvs()
  await rm(directory, { force: true, recursive: true })
})

async function projectedUsageIds() {
  const client = createClient({ url })
  clients.push(client)
  const result = await client.execute("SELECT DISTINCT id FROM vitehub_console_usage_v2 ORDER BY id")
  return result.rows.map(row => row.id)
}

async function generatedPlugin(retention: AgentRetentionPolicy, options: { d1?: string } = {}) {
  const plugin = agentInvocationsVitePlugin({
    database: false,
    default: { ...(options.d1 ? {} : { databaseUrl: url }), retention },
    ...(options.d1 ? { resolveD1Binding: () => options.d1 } : {}),
  })
  const configHook = plugin.config
  if (!configHook) throw new TypeError("Expected an Agent Invocations config hook.")
  const configHandler = "handler" in configHook ? configHook.handler : configHook
  await Reflect.apply(configHandler, {}, [{ root: directory }, { command: "build", mode: "production" }])
  return await readFile(join(directory, ".vitehub/nitro/agent/invocations.mjs"), "utf8")
}

async function generatedInstallation(retention: AgentRetentionPolicy) {
  const generated = await generatedPlugin(retention)
  const installation = generated.split("\n").find(line => line.startsWith("installAgentInvocations("))
  if (!installation) throw new TypeError("Expected a generated Agent Invocations installation.")
  return () => runInNewContext(installation, { installAgentInvocations })
}

describe("Default Agent journal retention", () => {
  it.each(["maxAge", "maxRecords", "maxSize"] as const)("rejects non-serializable %s directly and before Vite code generation", async (limit) => {
    for (const value of [() => 1, Symbol("retention")]) {
      const retention: AgentRetentionPolicy = {}
      Reflect.set(retention, limit, value)
      await expect(createDefaultAgentInvocations({ databaseUrl: url, projectRoot: directory, retention }).list()).rejects.toThrow(`SQLite Agent Invocation ${limit} must be a positive`)
      await expect(generatedPlugin(retention)).rejects.toThrow(`agent.invocations.retention ${limit} must be a positive`)
    }
  })

  it.each(["maxAge", "maxRecords", "maxSize"] as const)("rejects null %s directly and before Vite code generation", async (limit) => {
    const retention: AgentRetentionPolicy = {}
    Reflect.set(retention, limit, null)

    await expect(createDefaultAgentInvocations({ databaseUrl: url, projectRoot: directory, retention }).list()).rejects.toThrow(`SQLite Agent Invocation ${limit} must be a positive`)
    await expect(generatedPlugin(retention)).rejects.toThrow(`agent.invocations.retention ${limit} must be a positive`)
  })

  it.each([
    { maxAge: Number.NaN },
    { maxAge: Number.POSITIVE_INFINITY },
    { maxAge: Number.NEGATIVE_INFINITY },
    { maxRecords: Number.NaN },
    { maxRecords: Number.POSITIVE_INFINITY },
    { maxRecords: Number.NEGATIVE_INFINITY },
    { maxAge: "1000" },
    { maxAge: "14 days" },
    { maxRecords: "false" },
    { maxSize: "0%" },
    { maxSize: "101%" },
    { maxSize: "2PB" },
    { maxAgeMs: 1000 },
  ] as unknown as AgentRetentionPolicy[]) ("rejects invalid retention before Vite code generation: %j", async (retention) => {
    await expect(generatedPlugin(retention)).rejects.toThrow("agent.invocations.retention")
  })

  it.each([
    {},
    { maxAge: false, maxRecords: false, maxSize: false },
    { maxAge: 30 * day, maxRecords: 10 },
    { maxAge: "14d", maxSize: "30%" },
    { maxSize: "500 MB" },
  ] satisfies AgentRetentionPolicy[])(
    "preserves valid retention after Vite code generation: %j",
    async (retention) => {
      const install = await generatedInstallation(retention)
      expect(install).not.toThrow()
    },
  )

  it("keeps string units in the generated plugin", async () => {
    const generated = await generatedPlugin({ maxAge: "14d", maxSize: "30%" })
    expect(generated).toContain('"retention":{"maxAge":"14d","maxSize":"30%"}')
  })

  it("rejects maxSize with the D1 journal before code generation", async () => {
    await expect(generatedPlugin({ maxSize: "30%" }, { d1: "DB" })).rejects.toThrow("agent.invocations.retention.maxSize is not supported by the D1 journal")
    await expect(generatedPlugin({ maxAge: "14d", maxSize: false }, { d1: "DB" })).resolves.toContain('d1: { binding: "DB"')
  })

  it("installs a new journal when only maxSize changes", () => {
    const install = (maxSize: "1GB" | "2GB") => {
      installAgentInvocations({ default: { databaseUrl: url, retention: { maxSize } }, journal: { projectRoot: directory } })
      return resolveDefaultAgentInvocations()
    }
    const first = install("1GB")
    expect(install("1GB")).toBe(first)
    expect(install("2GB")).not.toBe(first)
  })

  it("applies maxSize to the default journal", async () => {
    const invocations = createDefaultAgentInvocations({ databaseUrl: url, projectRoot: directory, retention: { maxSize: 1 } })
    const result = await invocations.prune()
    expect([...result.ids].sort()).toEqual(["old", "recent"])
    expect(result.size).toMatchObject({ budgetBytes: 1 })
    // Small records share pages, so deleting them can leave the live page count unchanged.
    expect(result.size!.afterBytes).toBeLessThanOrEqual(result.size!.beforeBytes)
    expect((await invocations.list()).invocations.map(record => record.id)).toEqual(["running"])
  })

  it("removes the usage projection with a deleted or pruned invocation", async () => {
    const invocations = createDefaultAgentInvocations({ databaseUrl: url, projectRoot: directory })
    const usage = getConsoleUsageIndex(invocations)!
    await usage.rebuild()
    expect(await projectedUsageIds()).toEqual(["old", "recent"])

    await expect(invocations.delete("recent")).resolves.toBe("deleted")
    expect(await projectedUsageIds()).toEqual(["old"])

    expect(await invocations.prune({ olderThanMs: 30 * day })).toEqual({ dryRun: false, ids: ["old"] })
    expect(await projectedUsageIds()).toEqual([])
    expect(await usage.query()).toMatchObject({ totals: { invocations: 0 } })
    expect((await invocations.list()).invocations.map(record => record.id)).toEqual(["running"])
  })

  it("keeps every terminal record by default", async () => {
    const invocations = createDefaultAgentInvocations({ databaseUrl: url, projectRoot: directory })
    expect(await invocations.prune()).toEqual({ dryRun: false, ids: [] })
    expect((await invocations.list()).invocations).toHaveLength(3)
  })

  it("applies the configured retention to the default journal", async () => {
    const invocations = createDefaultAgentInvocations({ databaseUrl: url, projectRoot: directory, retention: { maxAge: "30d" } })
    expect(await invocations.prune({ dryRun: true })).toEqual({ dryRun: true, ids: ["old"] })
    expect(await invocations.prune()).toEqual({ dryRun: false, ids: ["old"] })
    expect((await invocations.list()).invocations.map(record => record.id).sort()).toEqual(["recent", "running"])
  })
})
