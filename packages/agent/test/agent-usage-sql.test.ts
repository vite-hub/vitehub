import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"
import { agentUsagePeriod, agentUsageRow, readAgentUsage, summarizeAgentUsage } from "../src/usage.ts"

import type { AgentUsageQuery, AgentUsageSqlClient } from "../src/usage.ts"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, maxRetries: 5, recursive: true })))
})

const hour = 3_600_000
const now = Date.parse("2026-11-20T12:30:00.000Z")
const at = (hours: number) => new Date(now - hours * hour).toISOString()

function finish(record: unknown, truncated = false) {
  return { attributes: { "usage.record": record, ...truncated ? { "vitehub.observation.truncated": true } : {} }, name: "agent.invocation.finish" }
}

function recorded(costUsd: unknown, extra: Record<string, unknown> = {}) {
  return { attributes: { "usage.costUsd": costUsd, ...extra }, name: "agent.usage.recorded" }
}

const fixtures: Array<{ id: string, agentName: string, hours: number, status?: "cancelled" | "completed" | "failed" | "running", title?: string, model?: string, observations: Array<{ attributes: Record<string, unknown>, name: string }> }> = [
  { agentName: "bot", hours: 1, id: "own-cost", observations: [finish({ cost: { usd: "0.10" }, model: " gpt ", usage: { inputTokens: 10, outputTokens: 5 } })], title: "Fix Login" },
  { agentName: "bot", hours: 2, id: "calls", observations: [finish({ calls: [
    { cost: { usd: "0.15" }, model: "small", usage: { inputTokens: 3, outputTokens: 1, outputTokenDetails: { reasoningTokens: 2 } } },
    { cost: { estimated: true, usd: "0.05" }, model: "small", usage: { inputTokenDetails: { cacheReadTokens: 4 }, inputTokens: 6, outputTokens: 2, totalTokens: 9 } },
    { cost: { usd: "0.000000000000000000000000000000000001" }, usage: { inputTokens: 1, outputTokens: 1 } },
  ], model: "large" })] },
  { agentName: "bot", hours: 3, id: "bad-call", observations: [finish({ calls: [{ model: "small", usage: { inputTokens: 1 } }, "text"], usage: { totalTokens: 7 } })] },
  { agentName: "triage", hours: 4, id: "recorded", model: "configured", observations: [finish({ usage: { inputTokens: 2, outputTokens: 2 } }), recorded("0.30", { "usage.costEstimated": true }), recorded("0.20")] },
  { agentName: "triage", hours: 5, id: "recorded-no-cost", observations: [finish({ usage: { totalTokens: 3 } }), recorded("0.30"), recorded("0.20", { "usage.hasCost": false })] },
  { agentName: "triage", hours: 6, id: "truncated", observations: [finish({ calls: [{ usage: { inputTokens: 1 } }], usage: { inputTokens: 8, outputTokens: 1 } }, true)] },
  { agentName: "triage", hours: 7, id: "configured-only", model: "configured", observations: [finish({})] },
  { agentName: "triage", hours: 8, id: "no-finish", observations: [recorded("1")] },
  { agentName: "bot", hours: 9, id: "details", observations: [finish({ cost: { usd: "1.5" }, usage: { details: { cachedInputTokens: 5, reasoningOutputTokens: 6 }, inputTokenDetails: { cacheWrite: 2 }, inputTokens: 20, outputTokens: 3.5 } })], status: "failed" },
  { agentName: "bot", hours: 10, id: "negative", observations: [finish({ cost: { usd: "1e3" }, usage: { inputTokens: -1, outputTokens: 2 } })], status: "cancelled" },
  { agentName: "bot", hours: 30, id: "yesterday", observations: [finish({ cost: { usd: "2" }, model: "gpt", usage: { inputTokens: 1, outputTokens: 1 } }), finish({ cost: { usd: "3" }, model: "gpt", usage: { inputTokens: 4, outputTokens: 1 } })] },
  { agentName: "bot", hours: 11, id: "grouped", observations: [finish({ calls: [
    { calls: [{ cost: { usd: "0.10" }, usage: { inputTokens: 3, outputTokens: 1 } }, { cost: { usd: "0.05" }, usage: { inputTokens: 2, outputTokens: 2 } }], model: "main" },
    { calls: [{ cost: { estimated: true, usd: "0.20" }, model: "aux-small", usage: { inputTokens: 4, outputTokens: 2 } }], model: "aux" },
  ], model: "driver" })] },
  { agentName: "bot", hours: 12, id: "group-total", observations: [finish({ calls: [
    { calls: [{ cost: { usd: "9" }, usage: { totalTokens: 1 } }, "text"], cost: { usd: "0.5" }, model: "x", usage: { totalTokens: 50 } },
    { calls: [{ calls: [{ usage: { inputTokens: 1, outputTokens: 1 } }] }], model: "deep" },
  ] })] },
  { agentName: "triage", hours: 13, id: "group-gap", title: "Écouter la file", observations: [finish({ calls: [{ calls: [{ cost: { usd: "0.01" }, usage: { inputTokens: 1, outputTokens: 1 } }, "text"], model: "m" }, { calls: [], model: "empty" }] })] },
  { agentName: "bot", hours: 0.5, id: "running", observations: [], status: "running" },
  { agentName: "bot", hours: 400, id: "too-old", observations: [finish({ cost: { usd: "9" }, usage: { totalTokens: 1 } })] },
]

async function journal() {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-usage-sql-"))
  directories.push(directory)
  const url = `file:${join(directory, "journal.sqlite")}`
  const store = createLibsqlAgentInvocationStore({ maxAge: false, maxRecords: false, url })
  for (const fixture of fixtures) {
    const time = fixture.id === "group-gap" ? "2026-11-19T21:30:00-02:00" : at(fixture.hours)
    const status = fixture.status ?? "completed"
    await store.create({
      agentName: fixture.agentName,
      ...fixture.model ? { annotations: { "agent.model.id": fixture.model } } : {},
      createdAt: time,
      id: fixture.id,
      status,
      ...fixture.title ? { title: fixture.title } : {},
      traceId: fixture.id,
      updatedAt: time,
      ...status === "running" ? {} : { completedAt: time },
      observations: fixture.observations.map((observation, index) => ({ ...observation, sequence: index + 1, timestamp: time, type: "lifecycle" as const })),
    })
  }
  const client = createClient({ url })
  return { client, store }
}

async function expected(store: Awaited<ReturnType<typeof journal>>["store"], query: AgentUsageQuery) {
  const period = agentUsagePeriod(query)
  if ("problem" in period) throw new Error(period.problem)
  const rows = []
  for (const summary of (await store.list({ limit: 100 })).invocations) rows.push(agentUsageRow((await store.get(summary.id)) ?? summary))
  return { period, summary: summarizeAgentUsage(rows, query, period) }
}

function withoutTime<T extends { generatedAt: string }>(value: T): Omit<T, "generatedAt"> {
  const { generatedAt: _generatedAt, ...rest } = value
  return rest
}

describe("readAgentUsage()", { timeout: 60_000 }, () => {
  it("matches a search with Unicode lowercase, as summarizeAgentUsage() does", async () => {
    const { client, store } = await journal()
    const query = { now, search: "écouter" }
    const { period, summary } = await expected(store, query)
    const result = await readAgentUsage(client, query, period)
    expect(result.sessions.map(session => session.id)).toEqual(["group-gap"])
    expect(withoutTime(result)).toEqual(withoutTime(summary))
    client.close()
  })

  it("answers each query as summarizeAgentUsage() does, in one statement and without a new table", async () => {
    const { client, store } = await journal()
    const tables = async () => (await client.execute("SELECT type, name FROM sqlite_master ORDER BY name")).rows.map(row => `${row.type}:${row.name}`)
    const before = await tables()
    const statements: string[] = []
    const counting: AgentUsageSqlClient = {
      async execute(statement) {
        statements.push(statement.sql)
        return await client.execute(statement)
      },
    }
    const queries: AgentUsageQuery[] = [
      { now },
      { now, window: "24h" },
      { now, window: "90d" },
      { agentName: "triage", now },
      { now, status: "completed" },
      { now, search: "LOGIN" },
      { now, search: "call" },
      { now, search: "écouter" },
    ]
    for (const query of queries) {
      const { period, summary } = await expected(store, query)
      expect(withoutTime(await readAgentUsage(counting, query, period)), JSON.stringify(query)).toEqual(withoutTime(summary))
    }
    expect(statements).toHaveLength(queries.length + queries.filter(query => query.search).length)
    expect(await tables()).toEqual(before)
    client.close()
  })

  it("follows updates at the same timestamp, deletes, backdated imports, and unreadable records", async () => {
    const { client, store } = await journal()
    const updatedAt = async () => (await client.execute({ args: ["own-cost"], sql: "SELECT updated_at FROM vitehub_agent_invocations WHERE id = ?" })).rows[0]?.updated_at
    const before = await updatedAt()
    await store.update("own-cost", { appendObservation: { attributes: { ...finish({ cost: { usd: "0.70" }, usage: { totalTokens: 99 } }).attributes, "vitehub.observation.id": "late-finish" }, name: "agent.invocation.finish", timestamp: at(1), type: "lifecycle" }, timestamp: at(1) })
    expect(await updatedAt()).toBe(before)
    await store.delete("details")
    const imported = at(20)
    await store.create({ agentName: "import", completedAt: imported, createdAt: imported, id: "imported", observations: [{ ...finish({ cost: { usd: "0.01" }, usage: { totalTokens: 1 } }), sequence: 1, timestamp: imported, type: "lifecycle" }], status: "completed", traceId: "imported", updatedAt: imported })
    for (const query of [{ now }, { now, window: "24h" }] satisfies AgentUsageQuery[]) {
      const { period, summary } = await expected(store, query)
      const result = await readAgentUsage(client, query, period)
      expect(withoutTime(result)).toEqual(withoutTime(summary))
      expect(result.sessions.map(session => session.id)).not.toContain("details")
      expect(result.sessions.find(session => session.id === "own-cost")?.totals.totalTokens).toBe(99)
      expect(result.sessions.map(session => session.id)).toContain("imported")
    }
    await client.execute({ args: ["yesterday"], sql: "UPDATE vitehub_agent_invocations SET record = json_remove(record, '$.observations') WHERE id = ?" })
    const { period } = await expected(store, { now })
    const broken = await readAgentUsage(client, { now }, period)
    expect(broken.partial).toBe(true)
    expect(broken.sessions.find(session => session.id === "yesterday")).toMatchObject({ partial: true, totals: { invocations: 1, totalTokensAvailable: false } })
    expect(broken.runs.map(run => run.id)).not.toContain("yesterday")
    client.close()
  })

  it("pages sessions with the cursor of summarizeAgentUsage()", async () => {
    const { client, store } = await journal()
    for (let index = 0; index < 60; index++) {
      const time = index % 2 === 0 ? "2026-11-20T00:22:00Z" : "2026-11-19T19:22:00-05:00"
      await store.create({ agentName: "bulk", completedAt: time, createdAt: time, id: `bulk-${String(index).padStart(2, "0")}`, observations: [{ ...finish({ cost: { usd: `0.0${index % 7}` }, usage: { totalTokens: index } }), sequence: 1, timestamp: time, type: "lifecycle" }], status: "completed", traceId: `bulk-${index}`, updatedAt: time })
    }
    const query = { agentName: "bulk", now, search: "bulk", status: "completed" } as const
    const first = await expected(store, query)
    const page = await readAgentUsage(client, query, first.period)
    expect(withoutTime(page)).toEqual(withoutTime(first.summary))
    expect(page.cursor).toBeDefined()
    const nextQuery = { ...query, cursor: page.cursor! }
    const next = await expected(store, nextQuery)
    expect(withoutTime(await readAgentUsage(client, nextQuery, next.period))).toEqual(withoutTime(next.summary))
    client.close()
  })

  it("uses UTC instants for window boundaries and search", async () => {
    const { client, store } = await journal()
    for (const [id, time] of [
      ["inside", "2026-11-19t11:30:00-0100"],
      ["outside", "2026-11-19T13:29:59.9999+01:00"],
      ["end", "2026-11-20T13:30:00.0009+01:00"],
      ["previous-day", "2026-11-18T19:30:00-17:00"],
    ] as const) {
      await store.create({ agentName: "boundary", completedAt: time, createdAt: time, id, observations: [{ ...finish({ usage: { totalTokens: 1 } }), sequence: 1, timestamp: time, type: "lifecycle" }], status: "completed", traceId: id, updatedAt: time })
    }
    const query = { agentName: "boundary", now, search: "boundary", window: "24h" } as const
    const { period, summary } = await expected(store, query)
    expect(summary.sessions.map(session => session.id)).toEqual(["end", "previous-day", "inside"])
    expect(withoutTime(await readAgentUsage(client, query, period))).toEqual(withoutTime(summary))
    client.close()
  })

  it.each([false, true])("preserves padded prices and exact out-of-range prices (fallback: %s)", async (fallback) => {
    const { client, store } = await journal()
    for (const [id, observations] of [
      ["finish", [finish({ cost: { usd: "00000000000001.25" }, model: "\tgpt\n", usage: { totalTokens: 1 } })]],
      ["recorded", [finish({ usage: { totalTokens: 1 } }), recorded(`0.1${"0".repeat(40)}`)]],
      ["nested", [finish({ calls: [{ calls: [{ cost: { usd: fallback ? `0.${"0".repeat(36)}1` : "0.5" }, usage: { totalTokens: 1 } }], model: "\tgpt\n" }] })]],
      ["large", [finish({ cost: { usd: fallback ? "98765432109876543210.01" : "12.01" }, usage: { totalTokens: 1 } })]],
    ] as const) {
      const time = at(1)
      await store.create({ agentName: "prices", annotations: { "agent.model.id": "\tgpt\n" }, completedAt: time, createdAt: time, id, observations: observations.map((observation, index) => ({ ...observation, sequence: index + 1, timestamp: time, type: "lifecycle" })), status: "completed", traceId: id, updatedAt: time })
    }
    const query = { agentName: "prices", now }
    const { period, summary } = await expected(store, query)
    const execute = vi.fn((statement: Parameters<AgentUsageSqlClient["execute"]>[0]) => client.execute(statement))
    expect(withoutTime(await readAgentUsage({ execute }, query, period))).toEqual(withoutTime(summary))
    expect(execute).toHaveBeenCalledTimes(fallback ? 2 : 1)
    client.close()
  })
})
