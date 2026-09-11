import { createClient } from "@libsql/client"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"
import { createD1AgentInvocationStore, d1AgentInvocationSchema } from "../src/invocations/d1.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"
import type { AgentInvocationStore } from "../src/invocations.ts"

const timestamp = new Date().toISOString()
const observations = [
  { name: "agent.tool.call", attributes: { output: "large tool payload".repeat(10_000) } },
  { name: "agent.invocation.finish", attributes: { "usage.record": { usage: { totalTokens: 12 } } } },
  { name: "agent.tool.call", attributes: { output: "later tool evidence" } },
  { name: "agent.invocation.finish", attributes: { "vitehub.observation.truncated": true } },
].map((entry, index) => ({ ...entry, sequence: index + 1, timestamp, type: "run" as const }))

describe("filtered invocation observation reads", () => {
  const client = createClient({ url: "file::memory:" })
  let miniflare: Miniflare
  let stores: Record<string, AgentInvocationStore>

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
      memory: createMemoryAgentInvocationStore(),
      libsql: createLibsqlAgentInvocationStore({ client }),
      d1: createD1AgentInvocationStore({ database }),
    }
  })
  afterAll(async () => { client.close(); await miniflare?.dispose() })

  it.each(["memory", "libsql", "d1"])("%s returns only requested evidence without changing the journal", async (name) => {
    const store = stores[name]!
    await store.create({
      createdAt: timestamp,
      id: "session",
      observations,
      status: "completed",
      traceId: "trace",
      updatedAt: timestamp,
    })
    const invocations = defineAgentInvocations({ store })
    const result = await store.get("session", { observationNames: ["agent.invocation.finish"] })
    expect(await invocations.get("session", { observationNames: ["agent.invocation.finish"] })).toEqual(result)
    expect(result?.observations).toEqual([observations[1], observations[3]])
    expect(JSON.stringify(result)).not.toContain("tool payload")
    expect(await store.get("missing", { observationNames: ["agent.invocation.finish"] })).toBeUndefined()
    expect((await store.get("session", { observationNames: [] }))?.observations).toEqual([])
    expect((await store.get("session", { observationNames: ["unknown' OR 1=1 --"] }))?.observations).toEqual([])
    const complete = await store.get("session")
    expect(complete?.observations).toHaveLength(4)
    expect(complete?.observations[0]?.name).toBe("agent.tool.call")
  })
})
