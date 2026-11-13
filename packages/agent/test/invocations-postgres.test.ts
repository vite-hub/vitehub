import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { postgresAgentInvocationTables } from "../src/invocations/postgres.ts"
import { createPostgresAgentInvocationStore } from "../src/invocations/postgres-store.ts"

import type { AgentInvocationPruneResult, AgentInvocationStoreCreateInput } from "../src/invocations.ts"
import type { PostgresAgentInvocationStoreOptions } from "../src/invocations/postgres-store.ts"

const useDatabase = vi.fn()
vi.mock("@vite-hub/database", () => ({ useDatabase }))

// Set it to a Postgres database that the test can write, for example one in `docker run postgres:17`.
const url = process.env.VITEHUB_TEST_POSTGRES_URL

const timestamp = "2026-01-01T00:00:00.000Z"
const invocation = (id: string, input: Partial<AgentInvocationStoreCreateInput> = {}): AgentInvocationStoreCreateInput => ({
  agentName: "reviewer",
  createdAt: timestamp,
  id,
  observations: [],
  status: "running",
  traceId: `trace:${id}`,
  updatedAt: timestamp,
  ...input,
})
const appended = (id: number, content = `step ${id}`) => ({
  attributes: { "vitehub.observation.id": `event:${id}`, "capability.id": "search", "message.content": content },
  name: "agent.tool.call",
  timestamp,
  type: "run" as const,
})

/**
 * The statements that `vitehub database generate` writes for the journal tables. They name the `public` schema in
 * references, so the test drops it to create the tables in its own schema.
 */
async function journalMigration(tablePrefix?: string): Promise<string[]> {
  const tables = postgresAgentInvocationTables({ tablePrefix })
  const statements = await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ ...tables }))
  return statements.map(statement => statement.replaceAll('"public".', ""))
}

describe("Database Agent Invocation store on postgres.js", () => {
  beforeEach(() => {
    vi.resetModules()
    useDatabase.mockReset()
  })

  it("uses the Postgres store, not the SQLite batch calls that postgres.js does not have", async () => {
    // Nothing listens on port 1, so the store fails when it connects, after it chose the Postgres path.
    const client = postgres("postgres://vitehub@127.0.0.1:1/vitehub", { connect_timeout: 1, max: 1 })
    useDatabase.mockReturnValue({ db: drizzle({ client }) })
    const { createDatabaseAgentInvocationStore } = await import("../src/invocations/database.ts")
    const store = createDatabaseAgentInvocationStore({ maxAge: false, maxRecords: false })

    const error: unknown = await Promise.resolve(store.create(invocation("routed"))).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toMatch(/batch|is not a function/)
    expect(Reflect.get(Object(error), "code")).toBe("ECONNREFUSED")
    await client.end({ timeout: 0 })
  })
})

describe("Postgres Agent Invocation tablePrefix", () => {
  beforeEach(() => {
    vi.resetModules()
    useDatabase.mockReset()
  })

  it.each(["", "support_", "a".repeat(25)])("accepts the lowercase prefix %j and keeps every derived name within 63 bytes", async (tablePrefix) => {
    const statements = (await journalMigration(tablePrefix)).join("\n")
    const names = [...statements.matchAll(/"([^"]+)"/g)].map(match => match[1]!).filter(name => name.startsWith(`${tablePrefix}invocations`))
    expect(names).toContain(`${tablePrefix}invocations_observations_invocation_fk`)
    for (const name of names) expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63)
  })

  it.each(["Support_", "a".repeat(26), "customer_support_agent_invocation_history_", "1st_", "support-"])("rejects the prefix %j for the schema and the store", (tablePrefix) => {
    const error = expect.objectContaining({ code: "AGENT_R0910" })
    expect(() => postgresAgentInvocationTables({ tablePrefix })).toThrow(error)
    expect(() => createPostgresAgentInvocationStore({ client: () => { throw new Error("unused") }, tablePrefix })).toThrow(error)
  })

  it("keeps a SQLite prefix that Postgres rejects valid for a SQLite Database", async () => {
    const { createDatabaseAgentInvocationStore } = await import("../src/invocations/database.ts")
    expect(() => createDatabaseAgentInvocationStore({ tablePrefix: "Support_" })).not.toThrow()
  })
})

describe.skipIf(!url)("Postgres Agent Invocation store", () => {
  // Two clients act as two server instances with their own connection pools. The first test wraps `first` in Drizzle,
  // which changes how it sends JSON parameters, and `second` stays a plain postgres.js client. Both use a schema of
  // this run only, so the test never touches the tables of the Database that the URL names.
  const schema = `vitehub_test_${process.pid}`
  let admin: postgres.Sql
  let first: postgres.Sql
  let second: postgres.Sql
  let tablePrefix: string
  let sequence = 0
  const store = (client: postgres.Sql, options: Partial<PostgresAgentInvocationStoreOptions> = {}) =>
    createPostgresAgentInvocationStore({ client: () => client, maxAge: false, maxRecords: false, tablePrefix, ...options })

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => {} })
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.unsafe(`CREATE SCHEMA ${schema}`)
    const options = { connection: { search_path: schema }, max: 4, onnotice: () => {} }
    first = postgres(url!, options)
    second = postgres(url!, options)
  })
  beforeEach(async () => {
    vi.resetModules()
    useDatabase.mockReset()
    tablePrefix = `run_${++sequence}_`
    for (const statement of await journalMigration(tablePrefix)) await first.unsafe(statement)
  })
  afterAll(async () => {
    await Promise.all([first?.end(), second?.end()])
    await admin?.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin?.end()
  })

  it("stores Invocations through createDatabaseAgentInvocationStore() on a postgres.js Drizzle Database", async () => {
    for (const statement of await journalMigration()) await first.unsafe(statement)
    useDatabase.mockReturnValue({ db: drizzle({ client: first }) })
    const { createDatabaseAgentInvocationStore } = await import("../src/invocations/database.ts")
    const journal = createDatabaseAgentInvocationStore({ database: "default", maxAge: false, maxRecords: false })

    const created = await journal.create(invocation("through-database"))
    expect(created).toMatchObject({ created: true, record: { id: "through-database", status: "running" } })
    await journal.update("through-database", { appendObservation: appended(1), timestamp })
    await expect(journal.get("through-database")).resolves.toMatchObject({ cursor: created.record.cursor, observations: [{ name: "agent.tool.call" }] })
    await expect(journal.list({ agentName: "reviewer" })).resolves.toMatchObject({ invocations: [{ id: "through-database" }] })
    expect(useDatabase).toHaveBeenCalledWith("default")
  })

  it("does not create missing tables and names them with a fix", async () => {
    const missing = `missing_${sequence}_`
    const journal = store(first, { database: "main", tablePrefix: missing })

    await expect(journal.create(invocation("no-table"))).rejects.toMatchObject({
      code: "AGENT_R1044",
      fix: expect.stringContaining("vitehub database migrate"),
      why: expect.stringContaining(`"${missing}invocations"`),
    })
    const [row] = await first.unsafe("SELECT to_regclass($1) IS NULL AS absent", [`${missing}invocations`])
    expect(row).toEqual({ absent: true })
  })

  it("migrates and uses the tables of a prefix with the maximum length", async () => {
    const longest = `max_${sequence}_`.padEnd(25, "x")
    for (const statement of await journalMigration(longest)) await first.unsafe(statement)
    const journal = store(first, { tablePrefix: longest })

    await journal.create(invocation("longest"))
    await journal.update("longest", { appendObservation: appended(1), timestamp })
    await expect(journal.list({})).resolves.toMatchObject({ invocations: [{ id: "longest" }] })
    await expect(journal.get("longest")).resolves.toMatchObject({ observations: [{ name: "agent.tool.call" }] })
  })

  it("creates a record once and returns the stored record to a retried create", async () => {
    const journal = store(first)
    const created = await journal.create(invocation("once", { capabilityIds: ["memory"] }))
    const retried = await store(second).create(invocation("once", { agentName: "other" }))

    expect(created.created).toBe(true)
    expect(retried).toEqual({ created: false, record: created.record })
    await expect(journal.getSummary("once")).resolves.toMatchObject({ agentName: "reviewer", capabilityIds: ["memory"], cursor: created.record.cursor })
    expect(Reflect.has(await journal.getSummary("once") ?? {}, "observations")).toBe(false)
  })

  it("appends observations from two instances as rows and moves them into the record when the run ends", async () => {
    const instances = [store(first), store(second)]
    await instances[0]!.create(invocation("appends"))
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      instances[index % 2]!.update("appends", { appendObservation: appended(index + 1), timestamp })))
    // A retried append with the same identity adds nothing.
    await instances[1]!.update("appends", { appendObservation: appended(3), timestamp })

    const running = await instances[1]!.get("appends")
    expect(running?.observations.map(observation => observation.attributes?.["vitehub.observation.id"]).sort()).toEqual(Array.from({ length: 20 }, (_, index) => `event:${index + 1}`).sort())
    expect(running?.observations.map(observation => observation.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
    const [rows] = await first.unsafe(`SELECT count(*)::int AS rows FROM ${tablePrefix}invocations_observations`)
    expect(rows).toEqual({ rows: 20 })

    await instances[0]!.update("appends", { status: "completed", timestamp: "2026-01-01T00:00:01.000Z" })
    const [after] = await first.unsafe(`SELECT count(*)::int AS rows FROM ${tablePrefix}invocations_observations`)
    expect(after).toEqual({ rows: 0 })
    await expect(instances[1]!.get("appends")).resolves.toMatchObject({ status: "completed", observations: running?.observations })
    await expect(instances[1]!.get("appends", { observationNames: ["missing"] })).resolves.toMatchObject({ observations: [] })
  })

  it("filters observation names and keeps text with U+0000", async () => {
    const journal = store(first)
    await journal.create(invocation("names", { observations: [{ name: "input.prompt", sequence: 1, timestamp, type: "run" }] }))
    await journal.update("names", { appendObservation: appended(2, "zero\u0000byte"), timestamp })

    await expect(journal.get("names", { observationNames: ["agent.tool.call"] })).resolves.toMatchObject({
      observations: [{ attributes: { "message.content": "zero\u0000byte" }, name: "agent.tool.call" }],
    })
    await expect(journal.get("names", { observationNames: ["input.prompt"] })).resolves.toMatchObject({ observations: [{ name: "input.prompt" }] })
    await expect(journal.list({ search: "zero" })).resolves.toMatchObject({ invocations: [{ id: "names" }] })
  })

  it("gives a claim to one instance and fences the stale owner after a takeover", async () => {
    const instances = [store(first), store(second)]
    await instances[0]!.create(invocation("claimed"))

    const claims = await Promise.all([instances[0]!.claim("claimed", "owner-a", 30_000), instances[1]!.claim("claimed", "owner-b", 30_000)])
    expect(claims.filter(Boolean)).toHaveLength(1)
    const [owner, other] = claims[0] ? ["owner-a", "owner-b"] : ["owner-b", "owner-a"]
    await expect(instances[1]!.claim("claimed", other!, 30_000)).resolves.toBe(false)
    await expect(instances[1]!.update("claimed", { annotations: { stale: true }, timestamp }, other)).resolves.toBeUndefined()
    await expect(instances[0]!.update("claimed", { annotations: { owned: true }, timestamp }, owner)).resolves.toMatchObject({ annotations: { owned: true } })

    const token = await instances[0]!.getClaimToken("claimed")
    await expect(instances[1]!.claim("claimed", "taker", 30_000, { replaceClaimToken: token })).resolves.toBe(true)
    await expect(instances[0]!.update("claimed", { annotations: { late: true }, timestamp }, owner)).resolves.toBeUndefined()
    await instances[0]!.release("claimed", owner!)
    await expect(instances[1]!.claim("claimed", "another", 30_000)).resolves.toBe(false)
    await instances[1]!.release("claimed", "taker")
    await expect(instances[1]!.claim("claimed", "another", 30_000)).resolves.toBe(true)
    await expect(instances[1]!.claim("claimed", "rotated", 30_000, { expectedClaimIds: ["another"] })).resolves.toBe(true)
    await expect(instances[1]!.claim("claimed", "forced", 30_000, { expectedCursor: "999999" })).resolves.toBe(false)
    await expect(instances[1]!.claim("claimed", "forced", 30_000, { expectedCursor: "not-a-cursor" })).resolves.toBe(false)
  })

  it("expires claims by the database clock, not the host clock", async () => {
    const instances = [store(first), store(second)]
    await instances[0]!.create(invocation("expiry"))
    await expect(instances[0]!.claim("expiry", "owner-a", 300)).resolves.toBe(true)

    // A host clock one hour ahead does not expire the claim.
    const now = Date.now()
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 60 * 60 * 1000)
    try {
      await expect(instances[1]!.claim("expiry", "owner-b", 30_000)).resolves.toBe(false)
    }
    finally {
      clock.mockRestore()
    }
    const [lease] = await first.unsafe(`SELECT claim_expires_at > now() AS live FROM ${tablePrefix}invocations WHERE id = 'expiry'`)
    expect(lease).toEqual({ live: true })

    await new Promise(resolve => setTimeout(resolve, 400))
    await expect(instances[1]!.claim("expiry", "owner-b", 30_000)).resolves.toBe(true)
    await expect(instances[0]!.update("expiry", { annotations: { stale: true }, timestamp }, "owner-a")).resolves.toBeUndefined()
  })

  it("applies maxRecords and maxAge to terminal records only", async () => {
    const journal = store(first)
    for (let index = 1; index <= 5; index++) {
      await journal.create(invocation(`done-${index}`, { status: "completed", updatedAt: `2026-01-0${index}T00:00:00.000Z` }))
    }
    await journal.create(invocation("active", { updatedAt: "2020-01-01T00:00:00.000Z" }))

    // DELETE ... RETURNING has no order, so compare sorted IDs.
    const pruned = async (result: AgentInvocationPruneResult | PromiseLike<AgentInvocationPruneResult>) => {
      const { dryRun, ids } = await result
      return { dryRun, ids: [...ids].sort() }
    }
    await expect(pruned(store(first, { maxRecords: 3 }).prune({ dryRun: true }))).resolves.toEqual({ dryRun: true, ids: ["done-1", "done-2"] })
    await expect(pruned(store(first, { maxRecords: 3 }).prune({}))).resolves.toEqual({ dryRun: false, ids: ["done-1", "done-2"] })
    await expect(pruned(journal.prune({ updatedBefore: "2026-01-04T00:00:00.000Z" }))).resolves.toEqual({ dryRun: false, ids: ["done-3"] })
    await expect(pruned(store(first, { maxAge: "1d" }).prune({}))).resolves.toEqual({ dryRun: false, ids: ["done-4", "done-5"] })
    await expect(journal.get("active")).resolves.toMatchObject({ status: "running" })

    // A terminal write applies the limits too.
    const limited = store(first, { maxRecords: 1 })
    await limited.create(invocation("first-done", { status: "failed" }))
    await limited.create(invocation("second-done", { status: "cancelled" }))
    await expect(journal.get("first-done")).resolves.toBeUndefined()
    await expect(journal.get("second-done")).resolves.toMatchObject({ status: "cancelled" })
  })

  it("deletes terminal records with their observation rows", async () => {
    const journal = store(first)
    await journal.create(invocation("deleted"))
    await journal.update("deleted", { appendObservation: appended(1), timestamp })

    await expect(journal.delete("deleted")).resolves.toBe("not-terminal")
    await expect(journal.delete("missing")).resolves.toBe("not-found")
    await first.unsafe(`UPDATE ${tablePrefix}invocations SET status = 'failed' WHERE id = 'deleted'`)
    await expect(journal.delete("deleted")).resolves.toBe("deleted")
    const [rows] = await first.unsafe(`SELECT count(*)::int AS rows FROM ${tablePrefix}invocations_observations`)
    expect(rows).toEqual({ rows: 0 })
  })

  it("lists, pages, and filters summaries", async () => {
    const journal = store(first)
    await journal.create(invocation("one", { annotations: { triggeredBy: " schedule " }, status: "completed" }))
    await journal.create(invocation("two", { agentName: "writer" }))
    await journal.update("two", { appendObservation: appended(1), timestamp })
    await journal.create(invocation("three", { annotations: { triggeredBy: "webhook" }, updatedAt: "2026-02-01T00:00:00.000Z" }))

    const page = await journal.list({ limit: 2 })
    expect(page.invocations.map(item => item.id)).toEqual(["three", "two"])
    await expect(journal.list({ cursor: page.cursor })).resolves.toMatchObject({ invocations: [{ id: "one" }] })
    await expect(journal.list({ status: ["completed"] })).resolves.toMatchObject({ invocations: [{ id: "one" }] })
    await expect(journal.list({ status: [] })).resolves.toEqual({ invocations: [] })
    await expect(journal.list({ capabilityId: "search" })).resolves.toMatchObject({ invocations: [{ id: "two" }] })
    await expect(journal.list({ triggeredBy: "schedule" })).resolves.toMatchObject({ invocations: [{ id: "one" }] })
    await expect(journal.list({ updatedSince: "2026-01-15T00:00:00.000Z" })).resolves.toMatchObject({ invocations: [{ id: "three" }] })
    await expect(journal.list({ search: "STEP 1" })).resolves.toMatchObject({ invocations: [{ id: "two" }] })
    await expect(journal.list({ search: "100%" })).resolves.toEqual({ invocations: [] })
    await expect(journal.listAgentNames()).resolves.toEqual(["reviewer", "writer"])
    await expect(journal.listCapabilityIds()).resolves.toEqual(["search"])
    await expect(journal.listCapabilityIds("reviewer")).resolves.toEqual([])
    await expect(journal.listTriggeredBy()).resolves.toEqual([" schedule ", "webhook"])
    await expect(journal.listTriggeredBy("writer")).resolves.toEqual([])
  })
})
