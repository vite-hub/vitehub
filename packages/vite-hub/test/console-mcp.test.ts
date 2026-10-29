import { Readable } from "node:stream"

import { registerViteHubMcpTools } from "@vite-hub/internal/runtime/mcp-tools"
import { H3 } from "h3"
import { afterEach, describe, expect, it } from "vitest"

import { addConsoleRpcHandler } from "../src/console/nitro.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
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
  Reflect.deleteProperty(globalThis, policyKey)
})

describe("ViteHub MCP", () => {
  it.each(["/", "/portal/"])("routes GET probes to MCP with base %s", async (base) => {
    installConsoleAccess({ mode: "open" })
    installConsoleSections("/mcp-test", ["comments"])
    const config: { handlers: Array<{ handler: string, route: string, method?: "post" }> } = { handlers: [] }
    addConsoleRpcHandler(config, "/runtime", base)
    const route = config.handlers.find(candidate => candidate.handler === "/runtime/server/mcp.js")!
    const app = new H3()
    app.on(route.method ?? "", route.route, handler)
    app.get(`${base}_vitehub/**`, () => new Response("Console HTML"))

    const probe = await app.request(route.route)
    expect(probe.status).toBe(405)
    expect(probe.headers.get("allow")).toBe("POST")
    expect(await probe.json()).toEqual({ message: "ViteHub MCP accepts JSON-RPC requests with POST." })
    const ping = await app.request(route.route, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) })
    expect(ping.status).toBe(200)
    expect(await ping.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} })
  })

  it("rejects invalid request IDs before executing tools", async () => {
    installConsoleAccess({ mode: "open" })
    installConsoleSections("/mcp-test", ["comments"])
    registerViteHubMcpTools("comments", [tool("comments_reply", "comments")])
    for (const id of [true, false, {}, [], [1]]) {
      const result = await rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "comments_reply" } })
      expect(result.status).toBe(400)
      expect(result.body).toMatchObject({ id: null, error: { code: -32600 } })
    }
    expect(calls).toHaveLength(0)
    for (const id of ["request", 0, 1, null]) {
      const result = await rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "comments_reply" } })
      expect(result.status).toBe(200)
      expect(result.body.id).toBe(id)
    }
    expect(calls).toHaveLength(4)
  })

  it("negotiates only revisions supported by the transport", async () => {
    installConsoleAccess({ mode: "open" })
    installConsoleSections("/mcp-test", ["comments"])
    for (const version of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]) {
      const result = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version } })
      expect(result.body.result.protocolVersion).toBe(["2025-11-25", "2025-06-18"].includes(version) ? version : "2025-11-25")
    }
  })

  it("rejects unsupported protocol headers before dispatching requests or notifications", async () => {
    installConsoleAccess({ mode: "open" })
    installConsoleSections("/mcp-test", ["comments"])
    registerViteHubMcpTools("comments", [tool("comments_list_threads", "comments")])
    for (const version of ["1999-01-01", "2025-03-26", "2024-11-05", "invalid"]) {
      for (const message of [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "comments_list_threads" } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ]) {
        expect((await rpc(message, { headers: { "MCP-Protocol-Version": version } })).status).toBe(400)
      }
    }
    expect(calls).toHaveLength(0)
    for (const version of ["2025-11-25", "2025-06-18"]) {
      expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { "MCP-Protocol-Version": version } })).status).toBe(200)
    }
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200)
  })

  it("validates all tool arguments against the advertised schema before execution", async () => {
    installConsoleAccess({ mode: "open" })
    installConsoleSections("/mcp-test", ["comments"])
    const checked = tool("comments_checked", "comments")
    checked.inputSchema = {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        status: { enum: ["open", "resolved"] },
        resolved: { type: "boolean" },
        nested: { type: "object", properties: { names: { type: "array", items: { type: "string" } } }, additionalProperties: false },
      },
      required: ["id"],
      additionalProperties: false,
    }
    registerViteHubMcpTools("comments", [checked])
    for (const input of [undefined, null, "bad", [], 1, true, {}, { id: 1 }, { id: "" }, { id: "t1", extra: true }, { id: "t1", limit: 0 }, { id: "t1", limit: 101 }, { id: "t1", limit: 1.5 }, { id: "t1", status: "all" }, { id: "t1", resolved: "false" }, { id: "t1", nested: { names: [1] } }]) {
      const result = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: checked.name, arguments: input } })
      expect(result.body.error).toMatchObject({ code: -32602 })
    }
    expect(calls).toHaveLength(0)
    const input = { id: "t1", limit: 100, status: "resolved", resolved: false, nested: { names: ["Ada"] } }
    expect((await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: checked.name, arguments: input } })).body.result.isError).toBe(false)
    expect(calls[0]?.input).toEqual(input)
    registerViteHubMcpTools("comments", [tool("comments_list_threads", "comments")])
    expect((await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "comments_list_threads" } })).body.result.isError).toBe(false)
    expect(calls[1]?.input).toEqual({})
  })

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

  it.each(["read", "write", "all"] as const)("enforces %s Console grants when listing and calling tools", async (grant) => {
    installConsoleAccess({ mode: "open", authorize: () => grant === "all" ? true : { sections: [grant === "read" ? "comments:read" : "comments"] } })
    installConsoleSections("/mcp-test", ["comments"])
    const reply = tool("comments_reply", "comments")
    reply.annotations = { readOnlyHint: false }
    const resolve = tool("comments_resolve_thread", "comments")
    delete resolve.annotations
    const tools = [tool("comments_list_threads", "comments"), tool("comments_get_thread", "comments"), reply, resolve]
    registerViteHubMcpTools("comments", tools)
    const permitted = grant === "read" ? tools.slice(0, 2) : tools

    const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect.soft(list.body.result.tools.map((entry: { name: string }) => entry.name)).toEqual(permitted.map(entry => entry.name))
    for (const entry of tools) {
      const called = await rpc({ jsonrpc: "2.0", id: entry.name, method: "tools/call", params: { name: entry.name } })
      if (permitted.includes(entry)) expect(called.body.result.isError).toBe(false)
      else expect.soft(called.body.error).toMatchObject({ code: -32602 })
    }
    expect(calls).toHaveLength(permitted.length)
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
})
