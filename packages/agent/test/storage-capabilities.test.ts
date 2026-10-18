import { describe, expect, it, vi } from "vitest"

import type { ReadonlyWorkspaceFacade } from "@vite-hub/workspace"

const runtime = (capabilities: Record<string, unknown>) => ({
  capabilities,
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

async function resolveTools(
  capabilities: unknown[],
  handles: Record<string, unknown>,
  workspace?: ReadonlyWorkspaceFacade,
) {
  const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
  const resolved = await resolveAgentCapabilities({ capabilities: capabilities as never }, runtime(handles), { context: {} }, workspace as never)
  return resolved.tools!
}

describe("storage capabilities", () => {
  it("exposes curated KV read and edit tools", async () => {
    const { kv } = await import("../src/capabilities.ts")
    const store = {
      del: vi.fn(async () => undefined),
      get: vi.fn(async () => "value"),
      keys: vi.fn(async () => ["app:1"]),
      set: vi.fn(async () => undefined),
    }

    await expect(resolveTools([kv()], { kv: { kind: "kv", value: store } }).then(tools => Object.keys(tools).sort())).resolves.toEqual(["kv_read"])

    const tools = await resolveTools([kv({ mode: "write" })], { kv: { kind: "kv", value: store } })
    expect(Object.keys(tools).sort()).toEqual(["kv_edit", "kv_read"])
    expect(tools.kv_edit?.policy).toBeUndefined()

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

  it("unwraps error-first KV and Blob primitive results for agent tools", async () => {
    const { blob, kv } = await import("../src/capabilities.ts")
    const failure = new Error("storage failed")
    const kvStore = {
      del: vi.fn(async () => [null, undefined] as const),
      get: vi.fn(async () => [null, ["tuple", "value"]] as const),
      keys: vi.fn(async () => [failure, undefined] as const),
      set: vi.fn(async () => [null, undefined] as const),
    }
    const blobStore = {
      get: vi.fn(async () => [null, new Blob(["body"])] as const),
      head: vi.fn(async () => [failure, undefined] as const),
      list: vi.fn(async () => [null, { blobs: [] }] as const),
    }

    const kvTools = await resolveTools([kv({ mode: "write" })], { kv: kvStore })
    await expect(kvTools.kv_read!.execute?.({ key: "tuple" })).resolves.toEqual(["tuple", "value"])
    await expect(kvTools.kv_read!.execute?.({ prefix: "app:" })).rejects.toBe(failure)
    await expect(kvTools.kv_edit!.execute?.({ key: "tuple", operation: "put", value: true })).resolves.toBeUndefined()

    const blobTools = await resolveTools([blob()], { blob: blobStore })
    await expect(blobTools.blob_read!.execute?.({ operation: "list", prefix: "images/" })).resolves.toEqual({ blobs: [] })
    await expect(blobTools.blob_read!.execute?.({ operation: "head", pathname: "images/a.png" })).rejects.toBe(failure)
  })

  it("exposes curated Blob read and edit tools", async () => {
    const { blob } = await import("../src/capabilities.ts")
    const workspaceBytes = new Uint8Array([1, 2, 3])
    const workspace = {
      fs: {
        readFile: vi.fn(async () => workspaceBytes),
      },
    } as unknown as ReadonlyWorkspaceFacade
    const store = {
      del: vi.fn(async () => undefined),
      get: vi.fn(async () => new Blob(["body"])),
      head: vi.fn(async () => ({ pathname: "images/a.png" })),
      list: vi.fn(async () => ({ blobs: [], hasMore: false })),
      put: vi.fn(async () => ({ pathname: "images/a.png" })),
    }

    await expect(resolveTools([blob()], { blob: store }).then(tools => Object.keys(tools).sort())).resolves.toEqual(["blob_read"])

    const tools = await resolveTools([blob({ mode: "write" })], { blob: store }, workspace)
    expect(Object.keys(tools).sort()).toEqual(["blob_edit", "blob_read"])
    expect(tools.blob_edit?.policy).toBeUndefined()

    await tools.blob_read!.execute?.({ operation: "get", pathname: "images/a.png" })
    await tools.blob_read!.execute?.({ operation: "head", pathname: "images/a.png" })
    await tools.blob_read!.execute?.({ limit: 500, operation: "list", prefix: "images/" })
    expect(store.list).toHaveBeenCalledWith({ cursor: undefined, folded: undefined, limit: 100, prefix: "images/" })
    await expect(Promise.resolve().then(() => tools.blob_read!.execute?.({ operation: "list" }))).rejects.toThrow("prefix")

    const body = new Blob(["data"], { type: "image/png" })
    await tools.blob_edit!.execute?.({ body, operation: "put", options: { contentType: "image/png" }, pathname: "images/a.png" })
    await tools.blob_edit!.execute?.({ operation: "put", pathname: "images/from-workspace.png", workspacePath: "screenshots/result.png" })
    await expect(Promise.resolve().then(() => tools.blob_edit!.execute?.({ body: "inline", operation: "put", pathname: "images/a.png", workspacePath: "screenshots/result.png" }))).rejects.toThrow("exactly one")
    await expect(Promise.resolve().then(() => tools.blob_edit!.execute?.({ operation: "put", pathname: "images/a.png" }))).rejects.toThrow("attachmentId, body, or workspacePath")
    await expect(tools.blob_edit!.execute?.({ operation: "delete", pathname: "images/a.png" })).resolves.toEqual({ pathname: "images/a.png", deleted: true })
    expect(store.put).toHaveBeenCalledWith("images/a.png", body, { contentType: "image/png" })
    expect(workspace.fs.readFile).toHaveBeenCalledWith("screenshots/result.png", { encoding: "binary" })
    expect(store.put).toHaveBeenCalledWith("images/from-workspace.png", workspaceBytes, undefined)
    expect(store.del).toHaveBeenCalledWith("images/a.png")
  })

  it("uploads a current input attachment by id", async () => {
    const { blob } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { resolveAttachmentData } = await import("../src/messages.ts")
    const bytes = new Uint8Array([1, 2, 3])
    const fetchData = vi.fn(async () => bytes)
    const attachment = { id: "attachment-1", mediaType: "image/jpeg", type: "image" as const, fetchData }
    const store = {
      del: vi.fn(),
      get: vi.fn(),
      head: vi.fn(),
      list: vi.fn(),
      put: vi.fn(async (pathname: string, _body: unknown, _options?: unknown) => ({ pathname })),
    }
    const resolved = await resolveAgentCapabilities(
      { capabilities: [blob({ mode: "write" })] },
      {
        ...runtime({ blob: store }),
        run: { messageId: "message-2", runId: "run-1" },
      },
      {
        messages: [
          { id: "message-1", parts: [{ id: "attachment-1", mediaType: "image/png", type: "image", data: "old" }], role: "user" },
          { id: "message-2", parts: [attachment], role: "user" },
        ],
      },
    )

    const invocationAttachment = resolved.messages[1]!.parts[0]!
    if (invocationAttachment.type !== "image") throw new Error("Expected image attachment")
    await resolveAttachmentData(invocationAttachment)
    await expect(resolved.tools!.blob_edit!.execute?.({
      attachmentId: "attachment-1",
      operation: "put",
      options: { contentType: "application/octet-stream" },
      pathname: "meals/current/original",
    })).resolves.toEqual({ pathname: "meals/current/original" })
    expect(store.put).toHaveBeenCalledWith("meals/current/original", bytes, { contentType: "image/jpeg" })
    expect(fetchData).toHaveBeenCalledOnce()

    const retried = await resolveAgentCapabilities(
      { capabilities: [blob({ mode: "write" })] },
      { ...runtime({ blob: store }), run: { messageId: "message-2", runId: "run-2" } },
      { messages: [{ id: "message-2", parts: [attachment], role: "user" }] },
    )
    await retried.tools!.blob_edit!.execute?.({ attachmentId: "attachment-1", operation: "put", pathname: "meals/retry/original" })
    expect(fetchData).toHaveBeenCalledTimes(2)
  })

  it("resolves encoded input attachments without advertising unresolved URLs", async () => {
    const { blob } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const store = {
      del: vi.fn(),
      get: vi.fn(),
      head: vi.fn(),
      list: vi.fn(),
      put: vi.fn(async (pathname: string, _body: unknown, _options?: unknown) => ({ pathname })),
    }
    const resolved = await resolveAgentCapabilities(
      { capabilities: [blob({ mode: "write" })] },
      { ...runtime({ blob: store }), run: { messageId: "message-1", runId: "run-1" } },
      {
        messages: [{
          id: "message-1",
          parts: [
            { data: "data:image/png;base64,AQID", id: "encoded", mediaType: "image/png", type: "image" },
            { data: "BAUG", id: "base64", mediaType: "image/jpeg", type: "image" },
            { data: "data:image/jpeg,%FF%D8%FF", id: "percent", mediaType: "image/jpeg", type: "image" },
            { data: "{\"meal\":true}", id: "json", mediaType: "application/json; charset=utf-8", type: "file" },
            { id: "remote", mediaType: "image/jpeg", type: "image", url: "https://example.com/photo.jpg" },
          ],
          role: "user",
        }],
      },
    )

    await resolved.tools!.blob_edit!.execute?.({ attachmentId: "encoded", operation: "put", pathname: "encoded.png" })
    await resolved.tools!.blob_edit!.execute?.({ attachmentId: "base64", operation: "put", pathname: "base64.jpg" })
    await resolved.tools!.blob_edit!.execute?.({ attachmentId: "percent", operation: "put", pathname: "percent.jpg" })
    await resolved.tools!.blob_edit!.execute?.({ attachmentId: "json", operation: "put", pathname: "meal.json" })
    await expect(resolved.tools!.blob_edit!.execute?.({ attachmentId: "remote", operation: "put", pathname: "remote.jpg" })).rejects.toThrow("must identify one current input attachment")

    expect(store.put).toHaveBeenNthCalledWith(1, "encoded.png", new Uint8Array([1, 2, 3]), { contentType: "image/png" })
    expect(store.put).toHaveBeenNthCalledWith(2, "base64.jpg", new Uint8Array([4, 5, 6]), { contentType: "image/jpeg" })
    expect(store.put).toHaveBeenNthCalledWith(3, "percent.jpg", new Uint8Array([255, 216, 255]), { contentType: "image/jpeg" })
    expect(store.put).toHaveBeenNthCalledWith(4, "meal.json", new TextEncoder().encode("{\"meal\":true}"), { contentType: "application/json; charset=utf-8" })
    expect(resolved.tools!.blob_edit!.description).not.toContain("remote")
  })

  it("resolves Blob tools for static Agent inspection without invocation input", async () => {
    const { blob } = await import("../src/capabilities.ts")
    const { defineAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [blob({ mode: "write" })],
      driver: { model: {} as never },
    })

    await expect(agent.resolve({
      capabilities: { blob: {} },
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    })).resolves.toMatchObject({ tools: { blob_edit: expect.any(Object) } })
  })

  it("falls back to the installed Blob primitive at tool execution time", async () => {
    const store = {
      list: vi.fn(async () => ({ blobs: [], hasMore: false })),
    }
    vi.doMock("@vite-hub/blob", () => ({ blob: store }))
    try {
      const { blob } = await import("../src/capabilities.ts")
      const tools = await resolveTools([blob()], {})

      await tools.blob_read!.execute?.({ operation: "list", prefix: "images/" })
      expect(store.list).toHaveBeenCalledWith({ cursor: undefined, folded: undefined, limit: 25, prefix: "images/" })
    }
    finally {
      vi.doUnmock("@vite-hub/blob")
    }
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
    const tools = await resolveTools([db({ mode: "write" })], {
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

    const writeTools = await resolveTools([db({ mode: "write" })], { db: database })
    expect(writeTools.db_exec?.policy).toBeUndefined()
    await expect(Promise.resolve().then(() => writeTools.db_exec!.execute?.({ rationale: "", statement: "delete from notes where id = 1" }))).rejects.toThrow("rationale")
    await expect(Promise.resolve().then(() => writeTools.db_exec!.execute?.({ rationale: "remove duplicate", statement: "delete from notes where id = 1; delete from notes where id = 2" }))).rejects.toThrow("exactly one")
    await expect(Promise.resolve().then(() => writeTools.db_exec!.execute?.({ rationale: "create table", statement: "create table notes (id integer)" }))).rejects.toThrow("schemaMode")
    await expect(writeTools.db_exec!.execute?.({ rationale: "remove duplicate", statement: "delete from notes where id = 1" })).resolves.toEqual({ ok: true })
    await expect(writeTools.db_exec!.execute?.({ rationale: "remove duplicate", statement: "with stale as (select id from notes) delete from notes where id in (select id from stale)" })).resolves.toEqual({ ok: true })

    const schemaTools = await resolveTools([db({ schemaMode: "write" })], { db: database })
    await expect(schemaTools.db_exec!.execute?.({ rationale: "create table", statement: "create table notes (id integer)" })).resolves.toEqual({ ok: true })
    await expect(Promise.resolve().then(() => schemaTools.db_exec!.execute?.({ rationale: "read", statement: "select * from notes" }))).rejects.toThrow("use db_query")
  })
})
