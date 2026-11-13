import { HTTPError } from "h3"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { defineMcpTool } from "../src/index.ts"
import { createMcpHandler, toMcpToolResult } from "../src/runtime.ts"

import type { H3Event } from "h3"
import type { McpPromptDefinition, McpResourceDefinition } from "../src/index.ts"
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
  error?: { code: number, data?: unknown, message: string }
  result: {
    capabilities?: unknown
    content: Array<{ text: string, type: string }>
    contents?: unknown
    instructions?: string
    isError: boolean
    prompts?: unknown
    resourceTemplates?: unknown
    resources?: unknown
    serverInfo?: unknown
    tools: unknown[]
  }
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

  it("passes the signed-in caller to the tools", async () => {
    const caller = { clientId: "client", clientName: "Claude Code", scopes: ["openid"], user: { id: "u1", name: "Ada" } }
    const { body } = await rpc({ verify: async () => [undefined, caller] }, "tools/call", { name: "whoami" })
    expect(body.result.content).toEqual([{ text: "Hello Ada", type: "text" }])
  })
})

describe("app MCP prompts, resources, and server info", () => {
  const reviewInput = z.object({ number: z.string().describe("The pull request number."), focus: z.string().optional() })
  const review: McpPromptDefinition<typeof reviewInput> = {
    title: "Review",
    description: "Review a pull request.",
    input: reviewInput,
    handler: ({ number, focus }, { caller }) => `Review pull request ${number}${focus ? ` for ${focus}` : ""} as ${caller?.user.name ?? "anyone"}.`,
  }
  const changelog = { uri: "docs://changelog", title: "Changelog", mimeType: "text/markdown", handler: () => "# Changelog" } satisfies McpResourceDefinition
  const files: Record<string, string> = { "drop/SKILL.md": "# Drop", "drop/references/api.md": "# API" }
  const skillFile = {
    uriTemplate: "skill://{name}/{+path}",
    description: "A file of a skill.",
    mimeType: "text/markdown",
    list: () => Object.keys(files).map(file => ({ uri: `skill://${file}` })),
    handler: (_uri, { variables }) => files[`${variables.name}/${variables.path}`],
  } satisfies McpResourceDefinition
  const logo = { uri: "assets://logo", mimeType: "image/png", handler: () => new Uint8Array([137, 80, 78, 71]) } satisfies McpResourceDefinition
  const options = { prompts: { review }, resources: { changelog, logo, skill_file: skillFile } }

  it("advertises prompts and resources only when the app has them", async () => {
    expect((await rpc({}, "initialize")).body.result.capabilities).toEqual({ tools: { listChanged: false } })
    expect((await rpc(options, "initialize")).body.result.capabilities).toEqual({
      prompts: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
      tools: { listChanged: false },
    })
    expect((await rpc({}, "prompts/list")).body.error?.code).toBe(-32601)
  })

  it("sends the configured instructions and server info, with icons on the request origin", async () => {
    const serverInfo = {
      name: "drop",
      title: "Drop",
      version: "0.1.0",
      description: "Publish docs for review.",
      websiteUrl: "/",
      icons: [{ mimeType: "image/svg+xml", sizes: ["any"], src: "/favicon.svg" }, { src: "https://cdn.example.com/icon.png" }],
    }
    const { body } = await rpc({ instructions: "Read the drop skill first.", serverInfo }, "initialize")
    expect(body.result.instructions).toBe("Read the drop skill first.")
    expect(body.result.serverInfo).toEqual({
      ...serverInfo,
      websiteUrl: "https://app.example.com/",
      icons: [{ mimeType: "image/svg+xml", sizes: ["any"], src: "https://app.example.com/favicon.svg" }, { src: "https://cdn.example.com/icon.png" }],
    })
    expect((await rpc({}, "initialize")).body.result.serverInfo).toEqual({ name: "fixture", title: "fixture", version: "1" })
  })

  it("lists each prompt with the fields of its input as arguments", async () => {
    const { body } = await rpc(options, "prompts/list")
    expect(body.result.prompts).toEqual([{
      arguments: [{ description: "The pull request number.", name: "number", required: true }, { name: "focus", required: false }],
      description: "Review a pull request.",
      name: "review",
      title: "Review",
    }])
  })

  it("gets a prompt with checked arguments and the caller", async () => {
    const caller = { clientId: "client", clientName: "Claude Code", scopes: [], user: { id: "u1", name: "Ada" } }
    const { body } = await rpc({ ...options, verify: async () => [undefined, caller] }, "prompts/get", { arguments: { focus: "bugs", number: "12" }, name: "review" })
    expect(body.result).toEqual({ messages: [{ content: { text: "Review pull request 12 for bugs as Ada.", type: "text" }, role: "user" }] })
    const invalid = await rpc(options, "prompts/get", { arguments: {}, name: "review" })
    expect(invalid.body.error).toMatchObject({ code: -32602, message: expect.stringMatching(/^Invalid arguments for review: number: /) })
    expect((await rpc(options, "prompts/get", { name: "missing" })).body.error?.code).toBe(-32602)
  })

  it("lists fixed resources, the resources of a template, and the templates", async () => {
    expect((await rpc(options, "resources/list")).body.result.resources).toEqual([
      { mimeType: "text/markdown", name: "changelog", title: "Changelog", uri: "docs://changelog" },
      { mimeType: "image/png", name: "logo", uri: "assets://logo" },
      { name: "skill://drop/SKILL.md", uri: "skill://drop/SKILL.md" },
      { name: "skill://drop/references/api.md", uri: "skill://drop/references/api.md" },
    ])
    expect((await rpc(options, "resources/templates/list")).body.result.resourceTemplates).toEqual([
      { description: "A file of a skill.", mimeType: "text/markdown", name: "skill_file", uriTemplate: "skill://{name}/{+path}" },
    ])
  })

  it("reads text, bytes, and template resources, and answers -32002 for an unknown URI", async () => {
    expect((await rpc(options, "resources/read", { uri: "docs://changelog" })).body.result.contents).toEqual([{ mimeType: "text/markdown", text: "# Changelog", uri: "docs://changelog" }])
    expect((await rpc(options, "resources/read", { uri: "assets://logo" })).body.result.contents).toEqual([{ blob: "iVBORw==", mimeType: "image/png", uri: "assets://logo" }])
    expect((await rpc(options, "resources/read", { uri: "skill://drop/references/api.md" })).body.result.contents).toEqual([{ mimeType: "text/markdown", text: "# API", uri: "skill://drop/references/api.md" }])
    expect((await rpc(options, "resources/read", { uri: "skill://drop/missing.md" })).body.error).toMatchObject({ code: -32002, data: { uri: "skill://drop/missing.md" } })
  })

  it("turns a 4xx error of a resource into its message and hides other errors", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const resources = {
      denied: { uri: "a://denied", handler: () => { throw new HTTPError({ message: "Sign in to read it.", status: 403 }) } },
      broken: { uri: "a://broken", handler: () => { throw new Error("database password is wrong") } },
    }
    expect((await rpc({ resources }, "resources/read", { uri: "a://denied" })).body.error).toMatchObject({ code: -32602, message: "Sign in to read it." })
    expect((await rpc({ resources }, "resources/read", { uri: "a://broken" })).body.error).toMatchObject({ code: -32603, message: "broken failed on the server." })
    expect(error).toHaveBeenCalledOnce()
    error.mockRestore()
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
