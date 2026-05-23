import { describe, expect, it, vi } from "vitest"

const runtime = (capabilities: Record<string, unknown>) => ({
  capabilities,
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

async function resolveTools(capabilities: unknown[], handles: Record<string, unknown>) {
  const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
  const resolved = await resolveAgentCapabilities({ capabilities: capabilities as never }, runtime(handles), {})
  return resolved.tools!
}

describe("storage capabilities", () => {
  it("exposes scoped Runtime Schedule read and edit tools", async () => {
    const { schedule } = await import("../src/capabilities.ts")
    const records = [
      { createdAt: new Date("2026-05-23T00:00:00.000Z"), cron: "0 9 * * *", enabled: true, id: "daily", target: "reports", updatedAt: new Date("2026-05-23T00:00:00.000Z") },
      { createdAt: new Date("2026-05-23T00:00:00.000Z"), cron: "0 10 * * *", enabled: true, id: "private", target: "private", updatedAt: new Date("2026-05-23T00:00:00.000Z") },
    ]
    const schedules = {
      create: vi.fn(async input => ({ ...input, createdAt: new Date("2026-05-23T00:00:00.000Z"), enabled: input.enabled ?? true, id: input.id || "created", updatedAt: new Date("2026-05-23T00:00:00.000Z") })),
      delete: vi.fn(async () => true),
      disable: vi.fn(async id => ({ ...records.find(record => record.id === id)!, enabled: false })),
      enable: vi.fn(async id => ({ ...records.find(record => record.id === id)!, enabled: true })),
      get: vi.fn(async id => records.find(record => record.id === id)),
      list: vi.fn(async () => records),
      update: vi.fn(async (id, input) => ({ ...records.find(record => record.id === id)!, ...input })),
    }

    await expect(resolveTools([schedule({ mode: "read", targets: ["reports"] })], { schedule: { schedules } }).then(tools => Object.keys(tools).sort())).resolves.toEqual(["schedule_read"])

    const tools = await resolveTools([schedule({ mode: "write", policy: "allow", targets: ["reports"] })], { schedule: { schedules } })
    expect(Object.keys(tools).sort()).toEqual(["schedule_edit", "schedule_read"])
    expect(tools.schedule_edit?.policy).toBe("allow")

    await expect(tools.schedule_read!.execute?.({ operation: "targets" })).resolves.toEqual({ targets: ["reports"] })
    await expect(tools.schedule_read!.execute?.({ operation: "list" })).resolves.toEqual([records[0]])
    await expect(tools.schedule_read!.execute?.({ id: "daily", operation: "get" })).resolves.toEqual(records[0])
    await expect(tools.schedule_read!.execute?.({ id: "private", operation: "get" })).rejects.toThrow("allowlist")

    await tools.schedule_edit!.execute?.({ cron: "15 9 * * *", id: "new-daily", operation: "create", target: "reports" })
    expect(schedules.create).toHaveBeenCalledWith({ cron: "15 9 * * *", enabled: undefined, id: "new-daily", target: "reports" })

    await expect(tools.schedule_edit!.execute?.({ cron: "0 8 * * *", operation: "create", target: "private" })).rejects.toThrow("allowlist")
    await expect(tools.schedule_edit!.execute?.({ cron: "0 8 * * *", operation: "create", target: "reports", timezone: "UTC" } as never)).rejects.toThrow()
    await tools.schedule_edit!.execute?.({ cron: "30 9 * * *", id: "daily", operation: "update" })
    expect(schedules.update).toHaveBeenCalledWith("daily", { cron: "30 9 * * *", enabled: undefined, target: undefined })
    await expect(tools.schedule_edit!.execute?.({ id: "private", operation: "delete" })).rejects.toThrow("allowlist")
  })

  it("blocks self-targeting Runtime Schedules unless explicitly allowed", async () => {
    const { schedule } = await import("../src/capabilities.ts")
    const schedules = {
      create: vi.fn(async input => input),
      delete: vi.fn(),
      disable: vi.fn(),
      enable: vi.fn(),
      get: vi.fn(),
      list: vi.fn(async () => []),
      update: vi.fn(),
    }

    const blocked = await resolveTools([schedule({ mode: "write", selfTarget: "agent/daily", targets: ["agent/daily"] })], { schedule: schedules })
    await expect(blocked.schedule_edit!.execute?.({ cron: "0 9 * * *", operation: "create", target: "agent/daily" })).rejects.toThrow("Self Schedule Permission")

    const allowed = await resolveTools([schedule({ allowSelfTarget: true, mode: "write", selfTarget: "agent/daily", targets: ["agent/daily"] })], { schedule: schedules })
    await expect(allowed.schedule_edit!.execute?.({ cron: "0 9 * * *", operation: "create", target: "agent/daily" })).resolves.toMatchObject({ target: "agent/daily" })
  })

  it("applies self-target permissions to Runtime Schedule list results", async () => {
    const { schedule } = await import("../src/capabilities.ts")
    const records = [
      { cron: "0 9 * * *", enabled: true, id: "own", target: "agent/daily" },
      { cron: "0 10 * * *", enabled: true, id: "reports", target: "reports" },
    ]
    const tools = await resolveTools([schedule({ mode: "read", selfTarget: "agent/daily", targets: ["agent/daily", "reports"] })], {
      schedule: {
        get: vi.fn(),
        list: vi.fn(async () => records),
      },
    })

    await expect(tools.schedule_read!.execute?.({ operation: "list" })).resolves.toEqual([records[1]])
  })

  it("accepts read-only Runtime Schedule clients in read mode", async () => {
    const { schedule } = await import("../src/capabilities.ts")
    const tools = await resolveTools([schedule({ mode: "read", targets: ["reports"] })], {
      schedule: {
        get: vi.fn(),
        list: vi.fn(async () => []),
      },
    })

    expect(Object.keys(tools)).toEqual(["schedule_read"])
  })

  it("uses strict Runtime Schedule tool schemas", async () => {
    const { schedule } = await import("../src/capabilities.ts")
    const tools = await resolveTools([schedule({ mode: "write", targets: ["reports"] })], {
      schedule: {
        create: vi.fn(),
        delete: vi.fn(),
        disable: vi.fn(),
        enable: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        update: vi.fn(),
      },
    })

    expect(tools.schedule_edit!.inputSchema).toMatchObject({
      additionalProperties: false,
      oneOf: expect.arrayContaining([
        expect.objectContaining({
          additionalProperties: false,
          properties: expect.not.objectContaining({
            at: expect.anything(),
            every: expect.anything(),
            policy: expect.anything(),
            timezone: expect.anything(),
          }),
        }),
      ]),
    })
  })

  it("exposes curated KV read and edit tools", async () => {
    const { kv } = await import("../src/capabilities.ts")
    const store = {
      del: vi.fn(async () => undefined),
      get: vi.fn(async () => "value"),
      keys: vi.fn(async () => ["app:1"]),
      set: vi.fn(async () => undefined),
    }

    await expect(resolveTools([kv()], { kv: { kind: "kv", value: store } }).then(tools => Object.keys(tools).sort())).resolves.toEqual(["kv_read"])

    const tools = await resolveTools([kv({ mode: "write", policy: "allow" })], { kv: { kind: "kv", value: store } })
    expect(Object.keys(tools).sort()).toEqual(["kv_edit", "kv_read"])
    expect(tools.kv_edit?.policy).toBe("allow")

    await expect(tools.kv_read!.execute?.({ key: "app:1" })).resolves.toBe("value")
    await expect(tools.kv_read!.execute?.({ prefix: "app:" })).resolves.toEqual(["app:1"])
    await expect(Promise.resolve().then(() => tools.kv_read!.execute?.({ key: "app:1", prefix: "app:" }))).rejects.toThrow("exactly one")
    await expect(Promise.resolve().then(() => tools.kv_read!.execute?.({}))).rejects.toThrow("exactly one")
    await expect(Promise.resolve().then(() => tools.kv_read!.execute?.({ key: null } as never))).rejects.toThrow("exactly one")
    expect(store.keys).toHaveBeenCalledTimes(1)

    await tools.kv_edit!.execute?.({ key: "app:2", operation: "put", value: { ok: true } })
    await tools.kv_edit!.execute?.({ key: "app:2", operation: "delete" })
    expect(store.set).toHaveBeenCalledWith("app:2", { ok: true })
    expect(store.del).toHaveBeenCalledWith("app:2")
  })

  it("selects configured KV and Blob stores from capability options", async () => {
    const { blob, kv } = await import("../src/capabilities.ts")
    const kvStore = { get: vi.fn(async () => "selected"), keys: vi.fn() }
    const blobStore = { get: vi.fn(), head: vi.fn(), list: vi.fn(async () => ({ blobs: [] })) }
    const kvRoot = { store: vi.fn(() => kvStore) }
    const blobRoot = { store: vi.fn(() => blobStore) }

    const kvTools = await resolveTools([kv({ store: "chat" })], { kv: kvRoot })
    await expect(kvTools.kv_read!.execute?.({ key: "thread:1" })).resolves.toBe("selected")
    expect(kvRoot.store).toHaveBeenCalledWith("chat")

    const blobTools = await resolveTools([blob({ store: "assets" })], { blob: blobRoot })
    await blobTools.blob_read!.execute?.({ operation: "list", prefix: "images/" })
    expect(blobRoot.store).toHaveBeenCalledWith("assets")
    expect(blobStore.list).toHaveBeenCalledWith({ cursor: undefined, folded: undefined, limit: 25, prefix: "images/" })
  })

  it("exposes curated Blob read and edit tools", async () => {
    const { blob } = await import("../src/capabilities.ts")
    const store = {
      del: vi.fn(async () => undefined),
      get: vi.fn(async () => new Blob(["body"])),
      head: vi.fn(async () => ({ pathname: "images/a.png" })),
      list: vi.fn(async () => ({ blobs: [], hasMore: false })),
      put: vi.fn(async () => ({ pathname: "images/a.png" })),
    }

    await expect(resolveTools([blob()], { blob: store }).then(tools => Object.keys(tools).sort())).resolves.toEqual(["blob_read"])

    const tools = await resolveTools([blob({ mode: "write" })], { blob: store })
    expect(Object.keys(tools).sort()).toEqual(["blob_edit", "blob_read"])
    expect(tools.blob_edit?.policy).toBe("require-approval")

    await tools.blob_read!.execute?.({ operation: "get", pathname: "images/a.png" })
    await tools.blob_read!.execute?.({ operation: "head", pathname: "images/a.png" })
    await tools.blob_read!.execute?.({ limit: 500, operation: "list", prefix: "images/" })
    expect(store.list).toHaveBeenCalledWith({ cursor: undefined, folded: undefined, limit: 100, prefix: "images/" })
    await expect(Promise.resolve().then(() => tools.blob_read!.execute?.({ operation: "list" }))).rejects.toThrow("prefix")

    const body = new Blob(["data"], { type: "image/png" })
    await tools.blob_edit!.execute?.({ body, operation: "put", options: { contentType: "image/png" }, pathname: "images/a.png" })
    await tools.blob_edit!.execute?.({ operation: "delete", pathname: "images/a.png" })
    expect(store.put).toHaveBeenCalledWith("images/a.png", body, { contentType: "image/png" })
    expect(store.del).toHaveBeenCalledWith("images/a.png")
  })

  it("defaults DB to schema and query tools and selects named databases", async () => {
    const { db } = await import("../src/capabilities.ts")
    const analytics = {
      query: vi.fn(async () => [{ id: 1 }]),
      schema: { events: true },
    }
    const dbPrimitive = {
      database: vi.fn(() => analytics),
    }
    const tools = await resolveTools([db({ database: "analytics" })], {
      db: dbPrimitive,
    })

    expect(Object.keys(tools).sort()).toEqual(["db_query", "db_schema"])
    await expect(tools.db_schema!.execute?.({})).resolves.toEqual({ database: "analytics", schema: { events: true } })
    await expect(tools.db_query!.execute?.({ statement: "select * from events;" })).resolves.toEqual([{ id: 1 }])
    expect(dbPrimitive.database).toHaveBeenCalledWith("analytics")
    expect(analytics.query).toHaveBeenCalledWith("select * from events")
  })

  it("selects the default DB through primitive database selectors", async () => {
    const { db } = await import("../src/capabilities.ts")
    const defaultDatabase = {
      query: vi.fn(async () => [{ id: 1 }]),
      schema: { notes: true },
    }
    const dbPrimitive = {
      database: vi.fn(() => defaultDatabase),
    }
    const tools = await resolveTools([db()], {
      db: dbPrimitive,
    })

    await expect(tools.db_schema!.execute?.({})).resolves.toEqual({ database: "default", schema: { notes: true } })
    await expect(tools.db_query!.execute?.({ statement: "select * from notes;" })).resolves.toEqual([{ id: 1 }])
    expect(dbPrimitive.database).toHaveBeenCalledWith("default")
    expect(defaultDatabase.query).toHaveBeenCalledWith("select * from notes")
  })

  it("expects an agent-facing raw SQL DB handle instead of adapting Drizzle entries", async () => {
    const { db } = await import("../src/capabilities.ts")
    const database = {
      db: { run: vi.fn() },
      schema: { notes: true },
    }
    const tools = await resolveTools([db({ mode: "write", policy: "allow" })], {
      db: database,
    })

    await expect(tools.db_schema!.execute?.({})).resolves.toEqual({ database: "default", schema: { notes: true } })
    await expect(tools.db_query!.execute?.({ statement: "select * from notes" })).rejects.toThrow("raw string query")
    await expect(tools.db_exec!.execute?.({ rationale: "cleanup", statement: "delete from notes where id = 1" })).rejects.toThrow("raw string exec")
    expect(database.db.run).not.toHaveBeenCalled()
  })

  it("resolves DB schema from method-style primitive handles", async () => {
    const { db } = await import("../src/capabilities.ts")
    const database = {
      query: vi.fn(async () => []),
      schema: vi.fn(async () => ({ notes: true })),
    }
    const tools = await resolveTools([db()], {
      db: database,
    })

    await expect(tools.db_schema!.execute?.({})).resolves.toEqual({ database: "default", schema: { notes: true } })
    expect(database.schema).toHaveBeenCalledTimes(1)
  })

  it("applies DB SQL guardrails and data/schema permissions", async () => {
    const { db } = await import("../src/capabilities.ts")
    const database = {
      exec: vi.fn(async () => ({ ok: true })),
      query: vi.fn(async () => ({ ok: true })),
      schema: {},
    }

    const readTools = await resolveTools([db()], { db: database })
    expect(readTools.db_exec).toBeUndefined()
    await expect(readTools.db_query!.execute?.({ statement: "select ';' as semi; -- trailing" })).resolves.toEqual({ ok: true })
    await expect(readTools.db_query!.execute?.({ statement: "pragma table_list" })).resolves.toEqual({ ok: true })
    await expect(readTools.db_query!.execute?.({ statement: "pragma index_xinfo(notes_title_idx)" })).resolves.toEqual({ ok: true })
    await expect(Promise.resolve().then(() => readTools.db_query!.execute?.({ statement: "select 1; select 2" }))).rejects.toThrow("only accepts one")
    await expect(Promise.resolve().then(() => readTools.db_query!.execute?.({ statement: "delete from notes" }))).rejects.toThrow("read-only")
    await expect(Promise.resolve().then(() => readTools.db_query!.execute?.({ statement: "begin transaction" }))).rejects.toThrow("read-only")
    await expect(readTools.db_query!.execute?.({ statement: "with x as (select 'delete') select * from x" })).resolves.toEqual({ ok: true })
    await expect(readTools.db_query!.execute?.({ statement: "with replace as (select 1) select * from replace" })).resolves.toEqual({ ok: true })
    await expect(readTools.db_query!.execute?.({ statement: "with [delete] as (select 1) select * from [delete]" })).resolves.toEqual({ ok: true })
    await expect(readTools.db_query!.execute?.({ statement: "with cleaned as (select replace(title, 'a', 'b') from notes) select * from cleaned" })).resolves.toEqual({ ok: true })

    const writeTools = await resolveTools([db({ mode: "write", policy: "allow" })], { db: database })
    expect(writeTools.db_exec?.policy).toBe("allow")
    await expect(Promise.resolve().then(() => writeTools.db_exec!.execute?.({ rationale: "", statement: "delete from notes where id = 1" }))).rejects.toThrow("rationale")
    await expect(Promise.resolve().then(() => writeTools.db_exec!.execute?.({ rationale: "remove duplicate", statement: "delete from notes where id = 1; delete from notes where id = 2" }))).rejects.toThrow("exactly one")
    await expect(Promise.resolve().then(() => writeTools.db_exec!.execute?.({ rationale: "create table", statement: "create table notes (id integer)" }))).rejects.toThrow("schemaMode")
    await expect(writeTools.db_exec!.execute?.({ rationale: "remove duplicate", statement: "delete from notes where id = 1" })).resolves.toEqual({ ok: true })
    await expect(writeTools.db_exec!.execute?.({ rationale: "remove duplicate", statement: "with stale as (select id from notes) delete from notes where id in (select id from stale)" })).resolves.toEqual({ ok: true })

    const schemaTools = await resolveTools([db({ policy: "allow", schemaMode: "write" })], { db: database })
    await expect(schemaTools.db_exec!.execute?.({ rationale: "create table", statement: "create table notes (id integer)" })).resolves.toEqual({ ok: true })
    await expect(Promise.resolve().then(() => schemaTools.db_exec!.execute?.({ rationale: "read", statement: "select * from notes" }))).rejects.toThrow("use db_query")
  })
})
