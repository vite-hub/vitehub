import { createClient } from "@libsql/client"
import type { InStatement } from "@libsql/client"
import { expect, it } from "vitest"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"

const timestamp = "2026-11-01T00:00:00.000Z"
const event = (id: string, sequence: number) => ({ attributes: { "capability.id": id }, name: "agent.tool.call", sequence, timestamp, type: "run" as const })
const invocation = (id: string, capabilityId: string) => ({ id, agentName: "review", createdAt: timestamp, updatedAt: timestamp, status: "running" as const, traceId: id, observations: [event(capabilityId, 1)] })

it("filters cached capability candidates in cursor order and keeps pagination", async () => {
  const client = createClient({ url: "file::memory:" })
  await client.execute(`CREATE TABLE vitehub_agent_invocations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    record TEXT NOT NULL
  )`)
  const plans: string[] = []
  const connection = new Proxy(client, {
    get(target, property) {
      if (property === "execute") return async (statement: InStatement) => {
        const sql = typeof statement === "string" ? statement : statement.sql
        if (sql.startsWith("SELECT sequence, COALESCE(summary,") && sql.includes("ORDER BY sequence DESC LIMIT ?")) {
          const plan = await target.execute(typeof statement === "string"
            ? `EXPLAIN QUERY PLAN ${statement}`
            : { ...statement, sql: `EXPLAIN QUERY PLAN ${statement.sql}` })
          plans.push(...plan.rows.map(row => String(row.detail)))
        }
        return target.execute(statement)
      }
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const store = createLibsqlAgentInvocationStore({ client: connection, maxAge: false, maxRecords: false })
  try {
    await store.create(invocation("first", "github"))
    await store.create(invocation("other", "shell"))
    await store.create(invocation("second", "github"))
    expect(await store.listCapabilityIds!("review")).toEqual(["github", "shell"])
    const firstPage = await store.list({ capabilityId: "github", limit: 1 })
    expect(firstPage.invocations.map(record => record.id)).toEqual(["second"])
    const secondPage = await store.list({ capabilityId: "github", cursor: firstPage.cursor, limit: 1 })
    expect(secondPage.invocations.map(record => record.id)).toEqual(["first"])
    expect(secondPage.cursor).toBeUndefined()
    expect(plans.some(detail => detail.includes("USING INDEX vitehub_agent_invocations_sequence_capability_ids"))).toBe(true)
  }
  finally { client.close() }
})
