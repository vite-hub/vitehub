import { Readable } from "node:stream"

import { registerViteHubMcpTools } from "@vite-hub/internal/runtime/mcp-tools"
import { afterEach, describe, expect, it } from "vitest"

import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleDatabase } from "../src/console/runtime/server/database.ts"
import handler from "../src/console/runtime/server/mcp.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"

import type { ViteHubMcpTool } from "@vite-hub/internal/runtime/mcp-tools"
import type { H3Event } from "h3"

const policyKey = Symbol.for("vitehub.console.access")
const calls: Array<{ input: Record<string, unknown>, user: unknown }> = []

function tool(name: string, section: string): ViteHubMcpTool {
  return {
    name,
    description: `The ${name} tool.`,
    section,
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    async call(input, context) {
      calls.push({ input, user: context.user })
      return { text: `ran ${name}`, structured: { ok: true } }
    },
  }
}

async function rpc(message: unknown, init: { headers?: Record<string, string>, method?: string } = {}) {
  const request = new Request("http://app.test/_vitehub/mcp", {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...init.headers },
    ...(init.method === "GET" ? {} : { body: JSON.stringify(message) }),
  })
  // SAFETY: the route reads the request and the method of the H3 event.
  const response = await handler({ method: request.method, req: request } as H3Event)
  const body: Record<string, any> = response.status === 202 ? {} : Object(await response.json())
  return { status: response.status, body }
}

afterEach(() => {
  calls.length = 0
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.mcp.tools"))
  Reflect.deleteProperty(globalThis, policyKey)
})

describe("ViteHub MCP", () => {
  it("initializes, and lists only the tools of installed sections that the person may use", async () => {
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["comments"] }) })
    installConsoleSections("/mcp-test", ["comments", "content"])
    registerViteHubMcpTools("comments", [tool("comments_list_threads", "comments")])
    registerViteHubMcpTools("content", [tool("content_read", "content")])
    registerViteHubMcpTools("queue", [tool("queue_send", "queues")])

    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })
    expect(init.body.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "vitehub", title: "ViteHub MCP" } })
    expect((await rpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })).body.result?.protocolVersion).toBe("2025-11-25")
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202)

    const list = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" })
    expect(list.body.result.tools).toEqual([{ name: "comments_list_threads", description: "The comments_list_threads tool.", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { readOnlyHint: true } }])
  })

  it("calls a tool with the Console user, and refuses tools outside the person's sections", async () => {
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["comments"] }) })
    installConsoleSections("/mcp-test", ["comments", "content"])
    registerViteHubMcpTools("comments", [tool("comments_list_threads", "comments")])
    registerViteHubMcpTools("content", [tool("content_read", "content")])

    const called = await rpc({ jsonrpc: "2.0", id: "a", method: "tools/call", params: { name: "comments_list_threads", arguments: { id: "t1" } } })
    expect(called.body).toEqual({ jsonrpc: "2.0", id: "a", result: { content: [{ type: "text", text: "ran comments_list_threads" }], structuredContent: { ok: true }, isError: false } })
    expect(calls).toEqual([{ input: { id: "t1" }, user: null }])
    const refused = await rpc({ jsonrpc: "2.0", id: "b", method: "tools/call", params: { name: "content_read" } })
    expect(refused.body.error).toMatchObject({ code: -32602 })
    expect(calls).toHaveLength(1)
  })

  it("answers the H3 1 events of Nuxt 4, which carry Node's request", async () => {
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["comments"] }) })
    installConsoleSections("/mcp-test", ["comments"])
    registerViteHubMcpTools("comments", [tool("comments_list_threads", "comments")])
    const req = Object.assign(Readable.from([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })]), {
      method: "POST",
      url: "/_vitehub/mcp",
      headers: { host: "app.test", origin: "http://app.test", "content-type": "application/json" },
    })
    const response: unknown = await Reflect.apply(handler, undefined, [{ node: { req }, context: {}, method: "POST" }])
    if (!(response instanceof Response)) throw new TypeError("Expected a Response")
    expect(response.status).toBe(200)
    expect(Object(await response.json()).result.tools.map((entry: { name: string }) => entry.name)).toEqual(["comments_list_threads"])
  })

  it("rejects other origins, GET, and bodies that are not one JSON-RPC message", async () => {
    installConsoleAccess({ mode: "open" })
    installConsoleSections("/mcp-test", ["comments"])
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { origin: "https://evil.test" } })).status).toBe(403)
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { origin: "http://app.test" } })).body.result).toEqual({})
    expect((await rpc(undefined, { method: "GET" })).status).toBe(405)
    expect((await rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }])).status).toBe(400)
    expect((await rpc({ jsonrpc: "2.0", id: 9, method: "resources/list" })).body.error).toMatchObject({ code: -32601 })
  })

  it("needs Console access", async () => {
    const denied = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect(denied.status).toBeGreaterThanOrEqual(401)
  })

  it("runs registered Database tools only inside installed and allowed sections", async () => {
    installConsoleDatabase("/mcp-test", {}, [])
    installConsoleSections("/mcp-test", ["databases", "comments"])
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["databases"] }) })
    const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect(list.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["database_list_databases", "database_get_schema"])
    const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "database_list_databases" } }
    expect((await rpc(call)).body.result.structuredContent).toEqual({ databases: [] })
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["comments"] }) })
    expect((await rpc(call)).body.error.code).toBe(-32602)
    installConsoleAccess({ mode: "open" })
    installConsoleSections("/mcp-test", ["comments"])
    expect((await rpc(call)).body.error.code).toBe(-32602)
  })

  it("tells the Agent what to change when a tool rejects its input", async () => {
    installConsoleDatabase("/mcp-test", {}, [])
    installConsoleSections("/mcp-test", ["databases"])
    installConsoleAccess({ mode: "open" })
    const call = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "database_get_schema", arguments: { database: 7 } } }
    expect((await rpc(call)).body.result).toMatchObject({ content: [{ text: "database must be a string." }], isError: true })
  })
})
