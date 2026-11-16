import { createClient } from "@libsql/client"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"
import { createD1AgentInvocationStore, d1AgentInvocationSchema } from "../src/invocations/d1.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"
import type { AgentInvocationGetOptions, AgentInvocationStore } from "../src/invocations.ts"
import type { InStatement } from "@libsql/client"

const timestamp = "2026-11-10T00:00:00.000Z"
const observation = (sequence: number, name: string) => ({
  attributes: { output: `payload ${sequence}` },
  name,
  sequence,
  timestamp,
  type: "run" as const,
})
const observations = [
  observation(1, "agent.tool.call"),
  observation(2, "agent.invocation.finish"),
  observation(3, "agent.tool.call"),
  observation(4, "agent.invocation.finish"),
]
const sequences = (record: { observations: readonly { sequence: number }[] } | undefined) => record?.observations.map(entry => entry.sequence)
const finish = ["agent.invocation.finish"]

describe("journal reads after a sequence", () => {
  const client = createClient({ url: "file::memory:" })
  let miniflare: Miniflare
  let stores: Record<"d1" | "libsql" | "memory", AgentInvocationStore>

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-14",
      d1Databases: ["DB"],
      modules: true,
      script: "export default { fetch() { return new Response('test') } }",
    })
    const database = await miniflare.getD1Database("DB")
    await database.batch(d1AgentInvocationSchema().map(sql => database.prepare(sql)))
    stores = {
      d1: createD1AgentInvocationStore({ database }),
      libsql: createLibsqlAgentInvocationStore({ client, maxAge: false, maxRecords: false }),
      memory: createMemoryAgentInvocationStore(),
    }
    for (const store of Object.values(stores)) {
      await store.create({ createdAt: timestamp, id: "done", observations, status: "completed", traceId: "trace", updatedAt: timestamp })
      // A running record keeps its first observation in the record and appends the others.
      await store.create({ createdAt: timestamp, id: "live", observations: [observations[0]!], status: "running", traceId: "live-trace", updatedAt: timestamp })
      for (const entry of observations.slice(1)) await store.update("live", { observation: entry, timestamp })
    }
  })
  afterAll(async () => {
    client.close()
    await miniflare?.dispose()
  })

  describe.each(["memory", "libsql", "d1"] as const)("%s store", (name) => {
    it.each(["done", "live"])("returns only later observations of the %s record in the store", async (id) => {
      const store = stores[name]
      expect(sequences(await store.get(id, { afterSequence: 2 }))).toEqual([3, 4])
      expect(sequences(await store.get(id, { afterSequence: 2, observationNames: finish }))).toEqual([4])
      expect(sequences(await store.get(id, { afterSequence: 0 }))).toEqual([1, 2, 3, 4])
      expect(sequences(await store.get(id, { afterSequence: 4 }))).toEqual([])
      expect(sequences(await store.get(id, { afterSequence: 1, observationNames: [] }))).toEqual([])
      expect(sequences(await store.get(id))).toEqual([1, 2, 3, 4])
      expect(await store.get("missing", { afterSequence: 1 })).toBeUndefined()
    })

    it("returns the same result through the journal", async () => {
      const invocations = defineAgentInvocations({ store: stores[name] })
      const record = await invocations.get("live", { afterSequence: 2 })
      expect(sequences(record)).toEqual([3, 4])
      expect(record).toEqual(await stores[name].get("live", { afterSequence: 2 }))
      expect(sequences(await invocations.get("live", { afterSequence: 2, observationNames: finish }))).toEqual([4])
    })
  })

  it("filters the observation rows of a running libSQL record in SQLite", async () => {
    const statements: InStatement[] = []
    const recording = new Proxy(client, {
      get(target, property) {
        const value = Reflect.get(target, property)
        if (property !== "batch") return typeof value === "function" ? value.bind(target) : value
        return async (batch: InStatement[], mode: "read") => {
          statements.push(...batch)
          return await target.batch(batch, mode)
        }
      },
    })
    const store = createLibsqlAgentInvocationStore({ client: recording, maxAge: false, maxRecords: false })
    expect(sequences(await store.get("live", { afterSequence: 2 }))).toEqual([3, 4])
    const query = statements.find(statement => typeof statement !== "string" && statement.sql.startsWith("SELECT position, observation FROM"))
    if (!query || typeof query === "string") throw new Error("Expected an observation row read")
    const plan = await client.execute({ args: query.args, sql: `EXPLAIN QUERY PLAN ${query.sql}` })
    expect(plan.rows.some(row => typeof row.detail === "string" && row.detail.includes("invocation_sequence=? AND <expr>>?"))).toBe(true)
  })

  it("filters the result of a store that ignores afterSequence", async () => {
    const memory = createMemoryAgentInvocationStore()
    await memory.create({ createdAt: timestamp, id: "done", observations, status: "completed", traceId: "trace", updatedAt: timestamp })
    const seen: (AgentInvocationGetOptions | undefined)[] = []
    const ignoring: AgentInvocationStore = {
      ...memory,
      get(id, options) {
        seen.push(options)
        return memory.get(id)
      },
    }
    const invocations = defineAgentInvocations({ store: ignoring })
    expect(sequences(await invocations.get("done", { afterSequence: 2 }))).toEqual([3, 4])
    expect(sequences(await invocations.get("done", { afterSequence: 1, observationNames: finish }))).toEqual([2, 4])
    expect(seen).toEqual([{ afterSequence: 2 }, { afterSequence: 1, observationNames: finish }])
  })

  it.each([-1, 1.5, Number.NaN, "2"])("rejects afterSequence %s before it reads the store", async (afterSequence) => {
    let reads = 0
    const memory = createMemoryAgentInvocationStore()
    const invocations = defineAgentInvocations({ store: { ...memory, get: (...args) => (reads++, memory.get(...args)) } })
    // A JavaScript caller, such as a query string reader, can pass a value that the type does not allow.
    const options: AgentInvocationGetOptions = {}
    Reflect.set(options, "afterSequence", afterSequence)
    await expect(invocations.get("done", options)).rejects.toMatchObject({ code: "AGENT_R1039" })
    expect(reads).toBe(0)
  })
})
