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
})
