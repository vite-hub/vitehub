import { Readable } from "node:stream"

import { registerViteHubMcpTools } from "@vite-hub/internal/runtime/mcp-tools"
import { H3 } from "h3"
import { afterEach, describe, expect, it, vi } from "vitest"

import { commentsOperations } from "../../comments/src/operations-core/operations.ts"
import { commentsMcpTools } from "../../comments/src/runtime/mcp.ts"
import { ada, anchor, createComments } from "../../comments/test/harness.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import { addConsoleRpcHandler } from "../src/console/nitro.ts"
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
  installConsoleOperations([])
  vi.restoreAllMocks()
  calls.length = 0
  Reflect.deleteProperty(globalThis, policyKey)
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.mcp.tools"))
})

describe("MCP owner contributions", () => {
  it("resolves real Comments operations and registered tools to one callable contract", async () => {
    const comments = await createComments()
    const [, thread] = await comments.create({ page: "/", anchor, body: "Please fix this", author: ada })
    installConsoleAccess({ mode: "auth", check: async () => undefined, user: async () => ada })
    installConsoleSections("/mcp-test", ["comments"])
    installConsoleOperations([{ operations: commentsOperations, plugin: "@vite-hub/comments" }])
    registerViteHubMcpTools("comments", commentsMcpTools(comments))

    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } })).status).toBe(200)
    expect((await rpc({ jsonrpc: "2.0", id: 2, method: "ping" })).body.result).toEqual({})
    const list = (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" })).body.result.tools
    const names = list.map((entry: { name: string }) => entry.name)
    expect(new Set(names).size).toBe(names.length)
    expect(list.find((entry: { name: string }) => entry.name === "comments_reply").inputSchema.required).toEqual(["id", "body"])
    const result = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "comments_reply", arguments: { id: thread!.id, body: "Fixed" } } })
    expect(result.body.result.isError).toBe(false)
    const [, updated] = await comments.get(thread!.id)
    expect(updated?.comments.at(-1)).toMatchObject({ body: "Fixed", author: ada })
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["comments:read"] }) })
    const readOnly = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/list" })
    expect(readOnly.body.result.tools.some((entry: { name: string }) => entry.name === "comments_reply")).toBe(false)
    expect((await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "comments_reply", arguments: { id: thread!.id, body: "Denied" } } })).body.error.code).toBe(-32602)
  })

  it("retains application OAuth wildcard discovery handlers", () => {
    const handlers = ["oauth-protected-resource", "oauth-authorization-server"].map(name => ({ route: `/.well-known/${name}/**`, handler: `/app/${name}.js` }))
    const config = { handlers: [...handlers] }
    addConsoleRpcHandler(config, "/runtime", "/portal/", [], true)
    for (const handler of handlers) expect(config.handlers).toContainEqual(handler)
    expect(config.handlers.filter(handler => handler.route.endsWith("/**") && handler.route.startsWith("/.well-known/"))).toEqual(handlers)
    expect(config.handlers[0]?.handler).toBe("/runtime/server/mcp-discovery.js")
  })

  it.each(["oauth-protected-resource", "oauth-authorization-server"])("delegates the application-owned bare %s route through config replay", async (name) => {
    const route = `/.well-known/${name}`
    const application = { route, handler: "/app/metadata.js", method: "get" }
    const config: { handlers: typeof application[]; virtual?: Record<string, unknown> } = { handlers: [application], virtual: { "virtual:app": "export default 1" } }
    installConsoleAccess({ mode: "auth", oauth: { path: "/_vitehub/mcp", auth: () => { throw new Error("Application discovery must bypass Console Auth") } } })
    for (const base of ["/", "/portal/"]) {
      addConsoleRpcHandler(config, "/runtime", base, [], true)
      expect(config.handlers).toContainEqual(application)
      expect(config.handlers.filter(handler => handler.route === route)).toEqual([application])
      expect(config.handlers[0]).toMatchObject({ middleware: true, route: "/**" })
      const source = config.virtual?.[config.handlers[0]!.handler]
      if (typeof source !== "string") throw new TypeError("Missing configured discovery middleware")
      // Load the generated wrapper against its source entry, without requiring a distribution build.
      const entry = new URL("../src/console/runtime/server/mcp-discovery.ts", import.meta.url).href
      const module = await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(source.replace(JSON.stringify("/runtime/server/mcp-discovery.js"), JSON.stringify(entry)))}`)
      const request = new Request(`http://app.test${route}`)
      await expect(module.default({ req: request })).resolves.toBeUndefined()
      expect(config.handlers).toContainEqual(expect.objectContaining({ route: `${route}/**`, handler: expect.stringMatching(/mcp-(metadata|authorization-server)\.js$/) }))
    }
    addConsoleRpcHandler(config, "/runtime", "/portal/", [], false)
    expect(config.handlers).toContainEqual(application)
    expect(config.virtual).toEqual({ "virtual:app": "export default 1" })
  })

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
    expect(await probe.json()).toMatchObject({ error: { code: -32600 } })
    const ping = await app.request(route.route, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) })
    expect(ping.status).toBe(200)
    expect(await ping.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} })
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
    // Since 2025-11-25, a schema failure is a tool error that the Agent reads. Arguments that are not an object stay a protocol error.
    const latest = { headers: { "MCP-Protocol-Version": "2025-11-25" } }
    const corrected = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: checked.name, arguments: { id: "t1", limit: 0 } } }, latest)
    expect(corrected.body.result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining(`Invalid arguments for ${checked.name}`) }] })
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: checked.name, arguments: "bad" } }, latest)).body.error).toMatchObject({ code: -32602 })
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
    expect(list.body.result.tools).toEqual([
      expect.objectContaining({ name: "definitions_list" }),
      expect.objectContaining({ name: "sections_list" }),
      { name: "comments_list_threads", description: "The comments_list_threads tool.", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { readOnlyHint: true } },
    ])
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
    expect.soft(list.body.result.tools.map((entry: { name: string }) => entry.name).filter((name: string) => name.startsWith("comments_"))).toEqual(permitted.map(entry => entry.name))
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
    expect(Object(await response.json()).result.tools.map((entry: { name: string }) => entry.name)).toEqual(["definitions_list", "sections_list", "comments_list_threads"])
  })

  it("needs Console access", async () => {
    const denied = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect(denied.status).toBeGreaterThanOrEqual(401)
  })

  it("checks the request limit of a contributed tool before it runs", async () => {
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["comments"] }) })
    installConsoleSections("/mcp-test", ["comments"])
    registerViteHubMcpTools("comments", [tool("comments_reply", "comments")])
    const call = (id: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "comments_reply", arguments: { id } } })
    expect((await rpc(call("x".repeat(256 * 1_024)))).status).toBe(413)
    expect(calls).toHaveLength(0)
    expect((await rpc(call("small"))).body.result.isError).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it("runs registered Database tools only inside installed and allowed sections", async () => {
    installConsoleDatabase("/mcp-test", {}, [])
    installConsoleSections("/mcp-test", ["databases", "comments"])
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["databases"] }) })
    const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect(list.body.result.tools.map((tool: { name: string }) => tool.name).filter((name: string) => name.startsWith("database_"))).toEqual(["database_list_databases", "database_get_schema"])
    const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "database_list_databases" } }
    expect((await rpc(call)).body.result.structuredContent).toEqual({ databases: [] })
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["comments"] }) })
    expect((await rpc(call)).body.error.code).toBe(-32602)
    installConsoleAccess({ mode: "open" })
    installConsoleSections("/mcp-test", ["comments"])
    expect((await rpc(call)).body.error.code).toBe(-32602)
  })

  it.each([undefined, "2025-06-18", "2025-11-25"])("reports schema validation failures and actionable tool request errors for revision %s", async (version) => {
    installConsoleDatabase("/mcp-test", {}, [])
    installConsoleSections("/mcp-test", ["databases"])
    installConsoleAccess({ mode: "open" })
    const init = { headers: version ? { "MCP-Protocol-Version": version } : undefined }
    const call = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "database_get_schema", arguments: { database: 7 } } }
    const invalid = (await rpc(call, init)).body
    if (version === "2025-11-25") expect(invalid.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("database_get_schema") }] })
    else expect(invalid.error).toMatchObject({ code: -32602, message: expect.stringContaining("database_get_schema") })
    const validCall = { ...call, params: { ...call.params, arguments: { database: "missing" } } }
    expect((await rpc(validCall, init)).body.result).toMatchObject({ content: [{ text: "No Database Definitions are configured." }], isError: true })
  })

  it.each([
    { error: Object.assign(new Error("Choose a valid limit."), { statusCode: 400 }), text: "Choose a valid limit." },
    { error: Object.assign(new Error("Internal diagnostics."), { statusCode: 404, statusMessage: "Store not found." }), text: "Store not found." },
    { error: Object.assign(new Error("Private server details."), { statusCode: 500, statusMessage: "Private server details." }), text: "comments_checked failed on the server." },
    { error: new Error("Private server details."), text: "comments_checked failed on the server." },
  ])("returns safe tool error text: $text", async ({ error, text }) => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    installConsoleSections("/mcp-test", ["comments"])
    installConsoleAccess({ mode: "open" })
    const checked = tool("comments_checked", "comments")
    checked.call = async () => { throw error }
    registerViteHubMcpTools("comments", [checked])
    const result = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: checked.name } })
    expect(result.body.result).toEqual({ content: [{ type: "text", text }], isError: true })
  })
})
