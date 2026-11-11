import { defineOperation } from "@vite-hub/internal/operations"
import { H3 } from "h3"
import * as v from "valibot"
import { loadOptions } from "nitro/builder"
import { afterEach, describe, expect, it, vi } from "vitest"

import { commentsOperations } from "../../comments/src/operations-core/operations.ts"
import { ada, anchor, createComments } from "../../comments/test/harness.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import { addConsoleRpcHandler } from "../src/console/nitro.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleDatabase } from "../src/console/runtime/server/database.ts"
import handler from "../src/console/runtime/server/mcp.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"

import type { OperationKind } from "@vite-hub/internal/operations"
import { requestEvent } from "./console-event.ts"
import type { NitroEventHandler } from "nitro/types"
import { verifyConsoleJwt } from "../src/console/runtime/server/bearer-jwt.ts"

const policyKey = Symbol.for("vitehub.console.access")
const calls: Array<{ input: Record<string, unknown>, user: unknown }> = []

/** An operation of the section before the dot, such as `comments` for `comments.ping`, that records its calls. */
function operation(name: string, kind: OperationKind = "read") {
  return defineOperation({
    description: `The ${name} operation.`,
    input: v.strictObject({ id: v.optional(v.string()) }),
    kind,
    name,
    run: async (input, context) => {
      calls.push({ input, user: context.user })
      return { ok: true }
    },
    section: name.slice(0, name.indexOf(".")),
  })
}

function install(...operations: ReturnType<typeof operation>[]) {
  installConsoleOperations([{ operations, plugin: "fixture-plugin" }])
}

async function rpc(message: unknown, init: { headers?: Record<string, string>, method?: string } = {}) {
  const request = new Request("http://app.test/_vitehub/mcp", {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...init.headers },
    ...(init.method === "GET" ? {} : { body: JSON.stringify(message) }),
  })
  const response = await handler.fetch(request)
  const body: Record<string, any> = response.status === 202 ? {} : Object(await response.json())
  return { status: response.status, body }
}

afterEach(() => {
  installConsoleOperations([])
  vi.restoreAllMocks()
  calls.length = 0
  Reflect.deleteProperty(globalThis, policyKey)
})

describe("MCP owner contributions", () => {
  it("serves the Comments operations with their MCP titles and text", async () => {
    const comments = await createComments()
    const [, thread] = await comments.create({ page: "/", anchor, body: "Please fix this", author: ada })
    installConsoleAccess({ mode: "auth", check: async () => undefined, user: async () => ada })
    installConsoleSections("/mcp-test", ["comments"])
    installConsoleOperations([{ operations: commentsOperations, plugin: "@vite-hub/comments" }])

    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } })).status).toBe(200)
    expect((await rpc({ jsonrpc: "2.0", id: 2, method: "ping" })).body.result).toEqual({})
    const list = (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" })).body.result.tools
    const names = list.map((entry: { name: string }) => entry.name)
    expect(new Set(names).size).toBe(names.length)
    expect(list.find((entry: { name: string }) => entry.name === "comments_threads")).toMatchObject({ title: "List comment threads", annotations: { readOnlyHint: true } })
    expect(list.find((entry: { name: string }) => entry.name === "comments_reply").inputSchema.required).toEqual(["body", "threadId"])
    const listed = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "comments_threads", arguments: {} } })
    expect(listed.body.result.content[0].text).toBe(`- ${thread!.id} /: Please fix this (Ada, 0 replies)`)
    expect(listed.body.result.structuredContent).toMatchObject({ status: "open", threads: [{ id: thread!.id, comment: "Please fix this" }] })
    const read = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "comments_get", arguments: { id: thread!.id } } })
    expect(read.body.result.content[0].text).toContain(`Thread #1 ${thread!.id} (open) on /`)
    const result = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "comments_reply", arguments: { threadId: thread!.id, body: "Fixed" } } })
    expect(result.body.result).toMatchObject({ content: [{ text: `Replied to thread ${thread!.id}.` }], isError: false })
    const [, updated] = await comments.get(thread!.id)
    expect(updated?.messages.at(-1)).toMatchObject({ body: "Fixed", author: ada })
    const resolved = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "comments_resolve", arguments: { threadId: thread!.id } } })
    expect(resolved.body.result.content[0].text).toBe(`Thread ${thread!.id} is resolved.`)
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["comments:read"] }) })
    const readOnly = await rpc({ jsonrpc: "2.0", id: 8, method: "tools/list" })
    expect(readOnly.body.result.tools.some((entry: { name: string }) => entry.name === "comments_reply")).toBe(false)
    expect((await rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "comments_reply", arguments: { threadId: thread!.id, body: "Denied" } } })).body.error.code).toBe(-32602)
  })

  it("keeps the delegating discovery middleware a virtual module through Nitro 3's options", async () => {
    const config: { handlers: NitroEventHandler[], virtual?: Record<string, string> } = {
      handlers: [{ route: "/.well-known/oauth-protected-resource", handler: "/app/metadata.js", method: "GET" }],
    }
    addConsoleRpcHandler(config, "/runtime", "/", [], true)
    const options = await loadOptions({ rootDir: "/app", handlers: config.handlers, virtual: config.virtual }, { dotenv: false })
    const middleware = options.handlers.find(handler => handler.middleware && !handler.route)
    expect(middleware?.handler).toBeDefined()
    expect(options.virtual).toHaveProperty([middleware!.handler])
  })

  it("retains application OAuth wildcard discovery handlers", () => {
    const handlers = ["oauth-protected-resource", "oauth-authorization-server"].map(name => ({ route: `/.well-known/${name}/**`, handler: `/app/${name}.js` }))
    const config = { handlers: [...handlers] }
    addConsoleRpcHandler(config, "/runtime", "/portal/", [], true)
    for (const handler of handlers) expect(config.handlers).toContainEqual(handler)
    expect(config.handlers.filter(handler => handler.route?.endsWith("/**") && handler.route.startsWith("/.well-known/"))).toEqual(handlers)
    expect(config.handlers[0]?.handler).toBe("/runtime/server/mcp-discovery.js")
  })

  it.each(["oauth-protected-resource", "oauth-authorization-server"])("delegates the application-owned bare %s route through config replay", async (name) => {
    const route = `/.well-known/${name}`
    const application = { route, handler: "/app/metadata.js", method: "get" }
    const config: { handlers: typeof application[]; plugins?: string[]; virtual?: Record<string, unknown> } = { handlers: [application], virtual: { "virtual:app": "export default 1" } }
    installConsoleAccess({ mode: "auth", oauth: { path: "/_vitehub/mcp", verify: verifyConsoleJwt, auth: () => { throw new Error("Application discovery must bypass Console Auth") } } })
    for (const base of ["/", "/portal/"]) {
      addConsoleRpcHandler(config, "/runtime", base, [], true)
      expect(config.handlers).toContainEqual(application)
      expect(config.handlers.filter(handler => handler.route === route)).toEqual([application])
      expect(config.handlers[0]).toMatchObject({ middleware: true })
      // Nitro 3 runs route-less middleware for every request.
      expect(config.handlers[0]?.route).toBeUndefined()
      const source = config.virtual?.[config.handlers[0]!.handler]
      if (typeof source !== "string") throw new TypeError("Missing configured discovery middleware")
      // Load the generated wrapper against its source entry, without requiring a distribution build.
      const entry = new URL("../src/console/runtime/server/mcp-discovery.ts", import.meta.url).href
      const module = await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(source.replace(JSON.stringify("/runtime/server/mcp-discovery.js"), JSON.stringify(entry)))}`)
      const request = new Request(`http://app.test${route}`)
      await expect(module.default(requestEvent(request))).resolves.toBeUndefined()
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

  it("initializes, and lists only the tools of the sections that the person may use", async () => {
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["comments"] }) })
    installConsoleSections("/mcp-test", ["comments", "content"])
    install(operation("comments.ping"), operation("content.read"), operation("queues.send"))

    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })
    expect(init.body.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "vitehub", title: "ViteHub MCP" } })
    expect((await rpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })).body.result?.protocolVersion).toBe("2025-11-25")
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202)

    const list = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" })
    expect(list.body.result.tools.map((entry: { name: string }) => entry.name).sort()).toEqual(["comments_ping", "definitions_list", "project_get", "sections_list"])
  })

  it("calls a tool, and refuses tools outside the person's sections", async () => {
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["comments"] }) })
    installConsoleSections("/mcp-test", ["comments", "content"])
    install(operation("comments.ping"), operation("content.read"))

    const called = await rpc({ jsonrpc: "2.0", id: "a", method: "tools/call", params: { name: "comments_ping", arguments: { id: "t1" } } })
    expect(called.body).toEqual({ jsonrpc: "2.0", id: "a", result: { content: [{ type: "text", text: "{\"ok\":true}" }], structuredContent: { ok: true }, isError: false } })
    expect(calls.map(call => call.input)).toEqual([{ id: "t1" }])
    const refused = await rpc({ jsonrpc: "2.0", id: "b", method: "tools/call", params: { name: "content_read" } })
    expect(refused.body.error).toMatchObject({ code: -32602 })
    expect(calls).toHaveLength(1)
  })

  it.each(["read", "write", "all"] as const)("enforces %s Console grants when listing and calling tools", async (grant) => {
    installConsoleAccess({ mode: "open", authorize: () => grant === "all" ? true : { sections: [grant === "read" ? "comments:read" : "comments"] } })
    installConsoleSections("/mcp-test", ["comments"])
    const operations = [operation("comments.list-threads"), operation("comments.get-thread"), operation("comments.reply", "write"), operation("comments.remove", "destructive")]
    install(...operations)
    const permitted = grant === "read" ? operations.slice(0, 2) : operations
    const tool = (name: string) => name.replace(".", "_")

    const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect.soft(list.body.result.tools.map((entry: { name: string }) => entry.name).filter((name: string) => name.startsWith("comments_")).sort()).toEqual(permitted.map(entry => tool(entry.name)).sort())
    for (const entry of operations) {
      const called = await rpc({ jsonrpc: "2.0", id: entry.name, method: "tools/call", params: { name: tool(entry.name), arguments: {} } })
      if (permitted.includes(entry)) expect(called.body.result.isError).toBe(false)
      else expect.soft(called.body.error).toMatchObject({ code: -32602 })
    }
    expect(calls).toHaveLength(permitted.length)
  })

  it("needs Console access", async () => {
    const denied = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect(denied.status).toBeGreaterThanOrEqual(401)
  })

  it("checks the request limit of an operation tool before it runs", async () => {
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["comments"] }) })
    installConsoleSections("/mcp-test", ["comments"])
    install(operation("comments.reply", "write"))
    const call = (id: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "comments_reply", arguments: { id } } })
    expect((await rpc(call("x".repeat(64 * 1_024)))).status).toBe(413)
    expect(calls).toHaveLength(0)
    expect((await rpc(call("small"))).body.result.isError).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it("runs Database operation tools only inside allowed sections", async () => {
    installConsoleDatabase("/mcp-test", {}, [])
    installConsoleSections("/mcp-test", ["databases", "comments"])
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["databases"] }) })
    const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    // Each ability is one tool, named after its operation.
    expect(list.body.result.tools.map((tool: { name: string }) => tool.name).filter((name: string) => name.startsWith("database")).sort()).toEqual(["databases_browse", "databases_tables"])
    const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "databases_tables", arguments: {} } }
    expect((await rpc(call)).body.result).toMatchObject({ content: [{ text: expect.stringContaining("No Database Definitions are configured.") }] })
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["comments"] }) })
    expect((await rpc(call)).body.error.code).toBe(-32602)
  })

  it.each([undefined, "2025-06-18", "2025-11-25"])("reports schema validation failures and actionable tool request errors for revision %s", async (version) => {
    installConsoleDatabase("/mcp-test", {}, [])
    installConsoleSections("/mcp-test", ["databases"])
    installConsoleAccess({ mode: "open" })
    const init = { headers: version ? { "MCP-Protocol-Version": version } : undefined }
    const call = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "databases_tables", arguments: { database: 7 } } }
    // Operation tools check their input when they run, so every revision gets a tool error that names the operation.
    expect((await rpc(call, init)).body.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Invalid input for databases.tables") }] })
    const validCall = { ...call, params: { ...call.params, arguments: { database: "missing" } } }
    expect((await rpc(validCall, init)).body.result).toMatchObject({ content: [{ text: expect.stringContaining("No Database Definitions are configured.") }], isError: true })
  })

  it.each([
    { error: Object.assign(new Error("Choose a valid limit."), { statusCode: 400 }), text: "Choose a valid limit." },
    { error: Object.assign(new Error("Internal diagnostics."), { statusCode: 404, statusMessage: "Store not found." }), text: "Store not found." },
    { error: Object.assign(new Error("Private server details."), { statusCode: 500, statusMessage: "Private server details." }), text: "comments.checked failed on the server." },
    { error: new Error("Private server details."), text: "comments.checked failed on the server." },
  ])("returns safe tool error text: $text", async ({ error, text }) => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    installConsoleSections("/mcp-test", ["comments"])
    installConsoleAccess({ mode: "open" })
    install(defineOperation({ ...operation("comments.checked"), run: async () => { throw error } }))
    const result = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "comments_checked", arguments: {} } })
    expect(result.body.result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining(text) }], isError: true })
    expect(JSON.stringify(result.body.result)).not.toContain("Private")
  })
})
