import { getViteHubMcpTools, registerViteHubMcpTools } from "@vite-hub/internal/runtime/mcp-tools"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { blobOperations } from "../../blob/src/operations.ts"
import { kvOperations } from "../../kv/src/operations.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import handler from "../src/console/runtime/server/mcp.ts"

const storage = vi.hoisted(() => ({
  kv: { list: vi.fn(), store: vi.fn(), get: vi.fn(), has: vi.fn(), set: vi.fn(), del: vi.fn() },
  blob: { list: vi.fn(), store: vi.fn(), get: vi.fn(), head: vi.fn(), put: vi.fn(), del: vi.fn() },
}))

// Use the owners' real operation schemas and runtime readers against provider stubs.
vi.mock("@vite-hub/kv", () => ({ kv: storage.kv }))
vi.mock("#vitehub/kv/config", () => ({ kv: { stores: { default: { driver: "fs-lite" }, cache: { driver: "fs-lite" } } } }))
vi.mock("@vite-hub/blob", () => ({ blob: storage.blob }))
vi.mock("@vite-hub/blob/runtime/state", () => ({
  getBlobRuntimeConfig: () => ({ stores: { default: { driver: "fs" }, archive: { driver: "fs" } } }),
}))

const context = { user: null }
const tool = (name: string) => getViteHubMcpTools().find(tool => tool.name === name)!

beforeEach(() => {
  vi.resetAllMocks()
  storage.kv.store.mockReturnValue({ ...storage.kv, list: vi.fn().mockResolvedValue([null, { keys: ["cached"] }]) })
  storage.kv.list.mockImplementation(async ({ cursor, limit, prefix }: { cursor?: string, limit: number, prefix: string }) => {
    const keys = ["a", "b", "c"].filter(key => key.startsWith(prefix))
    const start = Number(cursor ?? 0)
    const end = start + limit
    return [null, { keys: keys.slice(start, end), ...(end < keys.length ? { cursor: String(end) } : {}) }]
  })
  storage.blob.store.mockReturnValue(storage.blob)
  storage.blob.list.mockImplementation(async ({ cursor, limit, prefix }: { cursor?: string, limit: number, prefix: string }) => {
    const paths = ["_vitehub/private.json", "a.txt", "b.txt"].filter(path => path.startsWith(prefix))
    const start = Number(cursor ?? 0)
    const end = start + limit
    return [null, {
      blobs: paths.slice(start, end).map(pathname => ({
        pathname, size: 3, contentType: "text/plain", uploadedAt: new Date("2026-10-01T00:00:00Z"),
        customMetadata: { token: "secret" }, httpMetadata: { custom: "secret" }, httpEtag: "secret", url: "https://secret.test/token",
      })),
      hasMore: end < paths.length,
      ...(end < paths.length ? { cursor: String(end) } : {}),
    }]
  })
  installConsoleOperations([{ operations: kvOperations }, { operations: blobOperations }])
})

afterEach(() => {
  installConsoleOperations([])
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access"))
  vi.restoreAllMocks()
})

describe("storage MCP operation adapters", () => {
  it("registers lazily and removes tools when the owner operations are uninstalled", () => {
    expect(tool("kv_list_keys").annotations).toEqual({ readOnlyHint: true })
    expect(tool("blob_list_objects").annotations).toEqual({ readOnlyHint: true })
    expect(storage.kv.list).not.toHaveBeenCalled()
    expect(storage.blob.list).not.toHaveBeenCalled()
    installConsoleOperations([])
    expect(tool("kv_list_keys")).toBeUndefined()
    expect(tool("blob_list_objects")).toBeUndefined()
  })

  it("lists only KV keys using owner store selection, filtering, and pagination", async () => {
    const list = tool("kv_list_keys")
    expect((await list.call({ limit: 1 }, context)).structured).toEqual({ keys: ["a"], cursor: "1", limit: 1, prefix: "", store: "default", stores: ["default", "cache"] })
    expect((await list.call({ limit: 1, cursor: "1" }, context)).structured).toMatchObject({ keys: ["b"] })
    expect((await list.call({ prefix: "c" }, context)).structured).toMatchObject({ keys: ["c"], limit: 200 })
    expect((await list.call({ store: "cache" }, context)).structured).toMatchObject({ keys: ["cached"], store: "cache" })
    await expect(list.call({ store: "missing" }, context)).rejects.toThrow('KV store "missing" was not found.')
    expect(storage.kv.get).not.toHaveBeenCalled()
    expect(storage.kv.has).not.toHaveBeenCalled()
    expect(storage.kv.set).not.toHaveBeenCalled()
    expect(storage.kv.del).not.toHaveBeenCalled()
  })

  it("hides KV provider failures and makes expired cursors actionable", async () => {
    const list = tool("kv_list_keys")
    storage.kv.list.mockResolvedValue([Object.assign(new Error("provider secret"), { code: "KV_OPERATION_FAILED", cause: new Error("token") }), undefined])
    expect(await list.call({}, context)).toEqual({ text: "KV listing failed.", isError: true })
    storage.kv.list.mockResolvedValue([Object.assign(new Error("provider secret"), { code: "KV_INVALID_CURSOR" }), undefined])
    expect(await list.call({ cursor: "expired" }, context)).toEqual({ text: "The cursor expired. List again without a cursor.", structured: { errorCode: "cursor_expired" }, isError: true })
  })

  it("returns only allowed Blob metadata while retaining owner pagination and hidden-path filtering", async () => {
    const list = tool("blob_list_objects")
    const first = await list.call({ limit: 1 }, context)
    expect(first.structured).toEqual({ blobs: [{ pathname: "a.txt", size: 3, contentType: "text/plain", uploadedAt: "2026-10-01T00:00:00.000Z" }], cursor: "2", hasMore: true, limit: 1, prefix: "", store: "default", stores: ["default", "archive"] })
    expect(first.text).not.toContain("secret")
    expect((await list.call({ cursor: "2", limit: 1 }, context)).structured).toMatchObject({ blobs: [{ pathname: "b.txt" }], hasMore: false })
    expect((await list.call({ store: "archive", prefix: "b" }, context)).structured).toMatchObject({ blobs: [{ pathname: "b.txt" }], limit: 100, store: "archive" })
    await expect(list.call({ store: "missing" }, context)).rejects.toThrow('Blob store "missing" was not found.')
    expect(storage.blob.get).not.toHaveBeenCalled()
    expect(storage.blob.head).not.toHaveBeenCalled()
    expect(storage.blob.put).not.toHaveBeenCalled()
    expect(storage.blob.del).not.toHaveBeenCalled()
  })

  it.each(["kv_list_keys", "blob_list_objects"])("keeps %s bounded and rejects undeclared inputs", async name => {
    const list = tool(name)
    const maximum = name === "kv_list_keys" ? 500 : 250
    for (const limit of [0, maximum + 1, 1.5, "1"]) await expect(list.call({ limit }, context)).rejects.toThrow("limit")
    await expect(list.call({ prefix: {} }, context)).rejects.toThrow("Use only")
    await expect(list.call({ showVitehub: true }, context)).rejects.toThrow("Use only")
    expect(storage.kv.list).not.toHaveBeenCalled()
    expect(storage.blob.list).not.toHaveBeenCalled()
  })

  it("keeps storage tools behind installed sections and read grants at the MCP route", async () => {
    registerViteHubMcpTools("comments", [])
    registerViteHubMcpTools("console-database", [])
    registerViteHubMcpTools("content", [])
    installConsoleSections("/storage-mcp", ["kv", "blob"])
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["kv:read"] }) })
    async function rpc(method: string, params?: Record<string, unknown>) {
      const req = new Request("http://app.test/_vitehub/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
      const response: unknown = await Reflect.apply(handler, undefined, [{ req, context: {} }])
      if (!(response instanceof Response)) throw new TypeError("Expected a Response")
      return Object(await response.json())
    }
    const names: string[] = (await rpc("tools/list")).result.tools.map((entry: { name: string }) => entry.name)
    expect(names).toContain("kv_list_keys")
    expect(names).not.toContain("blob_list_objects")
    expect((await rpc("tools/call", { name: "kv_list_keys" })).result.structuredContent.keys).toEqual(["a", "b", "c"])
    expect((await rpc("tools/call", { name: "blob_list_objects" })).error.code).toBe(-32602)
    expect((await rpc("tools/call", { name: "kv_list_keys", arguments: { limit: 501 } })).error.code).toBe(-32602)
    expect((await rpc("tools/call", { name: "kv_list_keys", arguments: { store: "missing" } })).result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("was not found") }] })
    installConsoleSections("/storage-mcp", ["blob"])
    expect((await rpc("tools/call", { name: "kv_list_keys" })).error.code).toBe(-32602)
  })
})
