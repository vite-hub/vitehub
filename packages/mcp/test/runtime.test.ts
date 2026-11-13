import { HTTPError } from "h3"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { defineMcpTool } from "../src/index.ts"
import { createMcpHandler, toMcpToolResult } from "../src/runtime.ts"

import type { H3Event } from "h3"
import type { McpHandlerOptions } from "../src/runtime.ts"

const add = defineMcpTool({
  title: "Add",
  description: "Add two numbers.",
  input: z.object({ a: z.number(), b: z.number() }),
  annotations: { readOnlyHint: true },
  handler: ({ a, b }) => ({ sum: a + b }),
})

const whoami = defineMcpTool({
  description: "Who calls.",
  handler: (_input, { caller }) => caller ? `Hello ${caller.user.name}` : "Hello stranger",
})

function event(body: unknown, headers: Record<string, string> = {}): H3Event {
  const req = new Request("https://app.example.com/mcp", { body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers }, method: "POST" })
  // SAFETY: The handler reads only `req` and passes the event to the tools.
  return { req, url: new URL(req.url) } as unknown as H3Event
}

/** The JSON-RPC answer, or the JSON body of a rejection. */
interface Answer {
  code?: string
  error?: { code: number, message: string }
  result: { content: Array<{ text: string, type: string }>, isError: boolean, tools: unknown[] }
}

async function rpc(options: Partial<McpHandlerOptions>, method: string, params?: unknown, headers?: Record<string, string>) {
  const handler = createMcpHandler({ name: "fixture", route: "/mcp", tools: { add, whoami }, ...options })
  const response = await handler(event({ id: 1, jsonrpc: "2.0", method, ...(params ? { params } : {}) }, headers))
  // SAFETY: The tests read the fields of the answer that they assert.
  return { body: await response.json() as Answer, response }
}

describe("app MCP server", () => {
  it("lists each tool with the JSON Schema of its input", async () => {
    const { body } = await rpc({}, "tools/list")
    expect(body.result.tools).toEqual([
      {
        annotations: { readOnlyHint: true },
        description: "Add two numbers.",
        inputSchema: expect.objectContaining({ properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], type: "object" }),
        name: "add",
        title: "Add",
      },
      { description: "Who calls.", inputSchema: { type: "object" }, name: "whoami" },
    ])
  })

  it("calls a tool with checked input and returns data as JSON and structured content", async () => {
    const { body } = await rpc({}, "tools/call", { arguments: { a: 2, b: 3 }, name: "add" })
    expect(body.result).toEqual({ content: [{ text: "{\"sum\":5}", type: "text" }], isError: false, structuredContent: { sum: 5 } })
  })

  it("answers invalid input with a tool error that names the field", async () => {
    const { body } = await rpc({}, "tools/call", { arguments: { a: "2", b: 3 }, name: "add" }, { "mcp-protocol-version": "2025-11-25" })
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toMatch(/^Invalid arguments for add: a: /)
  })

  it("returns a protocol error for invalid arguments from a legacy client", async () => {
    const handler = vi.fn(() => "valid")
    const tools = { add: defineMcpTool({ ...add, handler }) }
    const { body } = await rpc({ tools }, "tools/call", { arguments: { a: "2", b: 3 }, name: "add" }, { "mcp-protocol-version": "2025-06-18" })
    expect(body.error).toMatchObject({ code: -32602, message: expect.stringMatching(/^Invalid arguments for add: a: /) })
    expect(handler).not.toHaveBeenCalled()
  })

  it("validates asynchronous schemas once and passes their transformed output", async () => {
    const validate = vi.fn(async () => ({ value: { a: 4, b: 5 } }))
    const tools = { add: defineMcpTool({ ...add, input: { ...add.input!, "~standard": { ...add.input!["~standard"], validate } } }) }
    const { body } = await rpc({ tools }, "tools/call", { arguments: { a: 1, b: 2 }, name: "add" })
    expect(body.result.content).toEqual([{ text: '{"sum":9}', type: "text" }])
    expect(validate).toHaveBeenCalledOnce()
  })

  it("advertises the mounted resource path in the OAuth challenge", async () => {
    const verify = async () => [{ code: "AUTH_MCP_TOKEN_MISSING", message: "Missing token." }, undefined] as const
    const { response } = await rpc({ route: "/portal/mcp", verify }, "tools/list")
    expect(response.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/portal/mcp"')
  })

  it("turns a 4xx error into a tool error and hides other errors", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const tools = {
      missing: defineMcpTool({ description: "Not found.", handler: () => { throw new HTTPError({ message: "No drop 42.", status: 404 }) } }),
      broken: defineMcpTool({ description: "Broken.", handler: () => { throw new Error("database password is wrong") } }),
    }
    expect((await rpc({ tools }, "tools/call", { name: "missing" })).body.result).toEqual({ content: [{ text: "No drop 42.", type: "text" }], isError: true })
    expect((await rpc({ tools }, "tools/call", { name: "broken" })).body.result).toEqual({ content: [{ text: "broken failed on the server.", type: "text" }], isError: true })
    expect(error).toHaveBeenCalledOnce()
    error.mockRestore()
  })

  it("rejects a request without a valid token with a 401 that names the resource metadata", async () => {
    const verify = vi.fn(async () => [{ code: "AUTH_MCP_TOKEN_MISSING", message: "The request has no access token." }, undefined] as const)
    const { body, response } = await rpc({ verify }, "tools/list")
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe("Bearer resource_metadata=\"https://app.example.com/.well-known/oauth-protected-resource/mcp\"")
    expect(body).toMatchObject({ code: "AUTH_MCP_TOKEN_MISSING" })

    const invalid = vi.fn(async () => [{ code: "AUTH_MCP_TOKEN_INVALID", message: "The access token is not valid: \"exp\" claim failed" }, undefined] as const)
    const rejected = await rpc({ verify: invalid }, "tools/list", undefined, { authorization: "Bearer old" })
    expect(rejected.response.headers.get("www-authenticate")).toBe("Bearer resource_metadata=\"https://app.example.com/.well-known/oauth-protected-resource/mcp\", error=\"invalid_token\", error_description=\"The access token is not valid: 'exp' claim failed\"")
  })

  it("rejects a tool that sets public when the server has no publicRoute", () => {
    for (const visibility of [true, false]) {
      const tools = { add, secret: defineMcpTool({ description: "Secret.", public: visibility, handler: () => "secret" }) }
      expect(() => createMcpHandler({ name: "fixture", route: "/mcp", tools })).toThrow(expect.objectContaining({ name: "MCP_R0001" }))
    }
    const tools = { search: defineMcpTool({ description: "Search.", public: true, handler: () => "results" }) }
    expect(() => createMcpHandler({ name: "fixture", publicRoute: "/mcp", route: "/mcp/account", tools })).not.toThrow()
  })

  it("passes the signed-in caller to the tools", async () => {
    const caller = { clientId: "client", clientName: "Claude Code", scopes: ["openid"], user: { id: "u1", name: "Ada" } }
    const { body } = await rpc({ verify: async () => [undefined, caller] }, "tools/call", { name: "whoami" })
    expect(body.result.content).toEqual([{ text: "Hello Ada", type: "text" }])
  })
})

describe("toMcpToolResult", () => {
  it("sends a string as text and keeps a result that has content blocks", () => {
    expect(toMcpToolResult("hi")).toEqual({ content: [{ text: "hi", type: "text" }], isError: false })
    const image = { content: [{ data: "AAAA", mimeType: "image/png", type: "image" }], isError: false }
    expect(toMcpToolResult(image)).toEqual(image)
    expect(toMcpToolResult([1, 2])).toEqual({ content: [{ text: "[1,2]", type: "text" }], isError: false })
  })
})
