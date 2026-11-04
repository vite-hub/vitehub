import { registerViteHubMcpTools } from "@vite-hub/internal/runtime/mcp-tools"
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

describe("storage MCP tools", () => {
  async function rpc(method: string, params?: Record<string, unknown>) {
    const req = new Request("http://app.test/_vitehub/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
    const response: unknown = await Reflect.apply(handler, undefined, [{ req, context: {} }])
    if (!(response instanceof Response)) throw new TypeError("Expected a Response")
    return Object(await response.json())
  }

  it("serves one tool per KV and Blob operation, behind read grants", async () => {
    registerViteHubMcpTools("comments", [])
    installConsoleSections("/storage-mcp", ["kv", "blob"])
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["kv:read"] }) })
    const names: string[] = (await rpc("tools/list")).result.tools.map((entry: { name: string }) => entry.name)
    expect(names.filter(name => name.startsWith("kv_")).sort()).toEqual(["kv_get", "kv_has", "kv_list"])
    expect(names.filter(name => name.startsWith("blob_"))).toEqual([])
    const listed = await rpc("tools/call", { name: "kv_list", arguments: { limit: 1 } })
    expect(listed.result.structuredContent).toMatchObject({ keys: ["a"], cursor: "1" })
    expect((await rpc("tools/call", { name: "kv_list", arguments: { store: "missing" } })).result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("was not found") }] })
    expect((await rpc("tools/call", { name: "kv_set", arguments: { key: "a", value: "b" } })).error.code).toBe(-32602)
    expect(storage.kv.set).not.toHaveBeenCalled()
  })

  it("keeps the Blob list free of provider URLs and secrets", async () => {
    registerViteHubMcpTools("comments", [])
    installConsoleSections("/storage-mcp", ["blob"])
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["blob:read"] }) })
    const listed = await rpc("tools/call", { name: "blob_list", arguments: { limit: 1 } })
    expect(listed.result.structuredContent).toMatchObject({ blobs: [{ pathname: "a.txt", size: 3, contentType: "text/plain" }], hasMore: true })
    expect(JSON.stringify(listed.result)).not.toContain("https://secret.test")
  })

  it("limits a store grant to that Blob store", async () => {
    registerViteHubMcpTools("comments", [])
    installConsoleSections("/storage-mcp", ["blob"])
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["content", "blob:archive"] }) })
    const names: string[] = (await rpc("tools/list")).result.tools.map((entry: { name: string }) => entry.name)
    expect(names.filter(name => name.startsWith("blob_")).sort()).toEqual(["blob_del", "blob_get", "blob_head", "blob_list", "blob_media", "blob_put", "blob_variants"])

    const listed = await rpc("tools/call", { name: "blob_list", arguments: { store: "archive" } })
    expect(listed.result.structuredContent).toMatchObject({ store: "archive", stores: ["archive"] })
    expect(storage.blob.store).toHaveBeenCalledWith("archive")
    storage.blob.head.mockResolvedValue([null, null])
    storage.blob.put.mockResolvedValue([null, { pathname: "photo.txt", size: 2, uploadedAt: new Date("2026-10-01T00:00:00Z"), customMetadata: {}, httpMetadata: {} }])
    const put = await rpc("tools/call", { name: "blob_put", arguments: { store: "archive", pathname: "photo.txt", data: btoa("hi") } })
    expect(put.result.structuredContent).toMatchObject({ created: true, store: "archive" })
    storage.blob.put.mockClear()
    storage.blob.list.mockClear()
    storage.blob.head.mockClear()

    // The default store is private: every call to it fails before the provider runs, with or without `store`.
    for (const [name, arguments_] of [
      ["blob_list", {}],
      ["blob_get", { pathname: "a.txt" }],
      ["blob_put", { pathname: "a.txt", data: btoa("hi") }],
      ["blob_del", { pathname: "a.txt", store: "default" }],
    ] as const) {
      const refused = (await rpc("tools/call", { name, arguments: arguments_ })).result
      expect(refused).toMatchObject({ isError: true, structuredContent: { error: { code: "CONSOLE_ACCESS_DENIED" } } })
      expect(refused.structuredContent.error.message).toContain('"blob:default"')
      expect(refused.structuredContent.error.fix).toContain('"blob" (every scope)')
    }
    expect(storage.blob.list).not.toHaveBeenCalled()
    expect(storage.blob.head).not.toHaveBeenCalled()
    expect(storage.blob.get).not.toHaveBeenCalled()
    expect(storage.blob.put).not.toHaveBeenCalled()
    expect(storage.blob.del).not.toHaveBeenCalled()
  })

  it("keeps a read-only store grant from writing", async () => {
    registerViteHubMcpTools("comments", [])
    installConsoleSections("/storage-mcp", ["blob"])
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["blob:archive:read"] }) })
    const names: string[] = (await rpc("tools/list")).result.tools.map((entry: { name: string }) => entry.name)
    expect(names.filter(name => name.startsWith("blob_")).sort()).toEqual(["blob_get", "blob_head", "blob_list", "blob_media", "blob_variants"])
    expect((await rpc("tools/call", { name: "blob_list", arguments: { store: "archive" } })).result.structuredContent).toMatchObject({ stores: ["archive"] })
    expect((await rpc("tools/call", { name: "blob_list", arguments: {} })).result).toMatchObject({ isError: true })
  })

  it.each(["kv", "blob"] as const)("masks %s provider failures", async (section) => {
    installConsoleSections("/storage-mcp", [section])
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: [`${section}:read`] }) })
    storage[section].list.mockResolvedValueOnce([{
      code: section === "kv" ? "KV_OPERATION_FAILED" : "BLOB_OPERATION_FAILED",
      message: "Provider request failed.",
      cause: new Error("private-provider-diagnostic at https://storage.example.test/private"),
    }, null])

    const failed = (await rpc("tools/call", { name: `${section}_list`, arguments: {} })).result
    expect(failed).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "OPERATION_FAILED", message: `${section}.list failed on the server.` } },
    })
    expect(JSON.stringify(failed)).not.toContain("private-provider-diagnostic")
    expect(JSON.stringify(failed)).not.toContain("storage.example.test")
  })

  it("masks every diagnostic field of a server failure", async () => {
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["kv:read"] }) })
    storage.kv.list.mockRejectedValueOnce(Object.assign(new Error("secret provider failure"), {
      status: 502, code: "secret-code", details: { secret: 1 }, docs: "https://secret.test", fix: "Use secret credentials.",
    }))
    const failed = (await rpc("tools/call", { name: "kv_list", arguments: {} })).result
    expect(failed).toEqual({
      content: [{ type: "text", text: "OPERATION_FAILED: kv.list failed on the server." }],
      isError: true,
      structuredContent: { error: { code: "OPERATION_FAILED", message: "kv.list failed on the server." } },
    })
  })
})
