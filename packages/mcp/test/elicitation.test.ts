import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { defineMcpTool } from "../src/index.ts"
import { createMcpHandler } from "../src/runtime.ts"

import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js"
import type { H3Event } from "h3"
import type { McpToolCaller } from "../src/index.ts"
import type { McpHandlerOptions } from "../src/runtime.ts"

const Invite = z.object({
  email: z.email().refine(email => email.endsWith("@acme.dev"), "Invite an acme.dev address."),
  role: z.enum(["viewer", "editor"]),
})

const shareDrop = defineMcpTool({
  description: "Share a drop with a teammate.",
  input: z.object({ drop: z.string() }),
  handler: async ({ drop }, { elicit }) => {
    const [error, answer] = await elicit(Invite, { message: `Who gets access to ${drop}?` })
    if (error) return `Did not share ${drop}: ${error.issues.map(issue => issue.message).join(" ")}`
    if (answer.action !== "accept") return `Did not share ${drop}: the person chose ${answer.action}.`
    return { drop, email: answer.data.email, role: answer.data.role }
  },
})

const listDrops = defineMcpTool({
  description: "List the drops.",
  handler: () => ({ drops: ["launch-notes"] }),
})

const origin = "https://app.example.com"

function eventOf(req: Request): H3Event {
  // SAFETY: The handler reads only `req` and passes the event to the tools.
  return { req, url: new URL(req.url) } as unknown as H3Event
}

function server(options: Partial<McpHandlerOptions> = {}) {
  return createMcpHandler({ name: "drops", route: "/mcp", tools: { list_drops: listDrops, share_drop: shareDrop }, ...options })
}

async function connect(handler: ReturnType<typeof server>, answer?: (message: string) => ElicitResult | Promise<ElicitResult>): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1" }, { capabilities: answer ? { elicitation: { form: {} } } : {} })
  if (answer) client.setRequestHandler(ElicitRequestSchema, request => answer(request.params.message))
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    fetch: (url, init) => handler(eventOf(new Request(url, init))),
  })
  await client.connect(transport)
  return client
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const [block] = z.array(z.object({ text: z.string(), type: z.literal("text") })).parse(result.content)
  return block!.text
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((settle) => { resolve = settle })
  return { promise, resolve }
}

describe("MCP elicitation through a real MCP client", () => {
  it("cancels both the pending prompt and a follow-up prompt when the SDK aborts just the call", async () => {
    const asked = deferred<void>()
    const response = deferred<ElicitResult>()
    const cancelled = deferred<string[]>()
    const handler = server({ tools: { ask_twice: defineMcpTool({
      description: "Ask twice.",
      async handler(_input, { elicit }) {
        const [, first] = await elicit(Invite, { message: "First" })
        const [, second] = await elicit(Invite, { message: "Second" })
        cancelled.resolve([first?.action ?? "invalid", second?.action ?? "invalid"])
        return "Done."
      },
    }) } })
    const client = await connect(handler, () => {
      asked.resolve()
      return response.promise
    })
    const controller = new AbortController()
    const call = client.callTool({ name: "ask_twice" }, undefined, { signal: controller.signal })
    try {
      await asked.promise
      controller.abort()
      await expect(call).rejects.toThrow()
      await expect(cancelled.promise).resolves.toEqual(["cancel", "cancel"])
      await expect(client.ping()).resolves.toEqual({})
    }
    finally {
      response.resolve({ action: "decline" })
      await client.close()
    }
  })

  it("asks the person and continues the tool call with the checked answer", async () => {
    const asked: string[] = []
    const client = await connect(server(), (message) => {
      asked.push(message)
      return { action: "accept", content: { email: "sam@acme.dev", role: "editor" } }
    })
    const result = await client.callTool({ name: "share_drop", arguments: { drop: "launch-notes" } })
    expect(asked).toEqual(["Who gets access to launch-notes?"])
    expect(result.isError).toBe(false)
    expect(result.structuredContent).toEqual({ drop: "launch-notes", email: "sam@acme.dev", role: "editor" })
    await client.close()
  })

  it("gives the handler a decline", async () => {
    const client = await connect(server(), () => ({ action: "decline" }))
    const result = await client.callTool({ name: "share_drop", arguments: { drop: "launch-notes" } })
    expect(text(result)).toBe("Did not share launch-notes: the person chose decline.")
    await client.close()
  })

  it("gives the handler the form error of an answer that the schema refuses", async () => {
    const client = await connect(server(), () => ({ action: "accept", content: { email: "sam@gmail.com", role: "viewer" } }))
    const result = await client.callTool({ name: "share_drop", arguments: { drop: "launch-notes" } })
    expect(text(result)).toBe("Did not share launch-notes: Invite an acme.dev address.")
    await client.close()
  })

  it("fails the call with MCP_ELICITATION_CLIENT_UNSUPPORTED for a client without the elicitation capability", async () => {
    const client = await connect(server())
    const result = await client.callTool({ name: "share_drop", arguments: { drop: "launch-notes" } })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain("MCP_ELICITATION_CLIENT_UNSUPPORTED")
    expect(text(result)).toContain("cannot ask the person")
    await client.close()
  })

  it("fails the call with MCP_ELICITATION_HOST_UNSUPPORTED on a host where the answer can reach another instance", async () => {
    const client = await connect(server({ elicitationUnsupportedHost: "cloudflare-module" }), () => ({ action: "decline" }))
    const result = await client.callTool({ name: "share_drop", arguments: { drop: "launch-notes" } })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain("MCP_ELICITATION_HOST_UNSUPPORTED")
    expect(text(result)).toContain("cloudflare-module")
    await client.close()
  })
})

interface SseMessage {
  id?: string | number
  method?: string
  params?: { message?: string, mode?: string, requestedSchema?: unknown }
  result?: { content?: unknown, isError?: boolean, structuredContent?: unknown }
}

async function nextMessage(reader: ReadableStreamDefaultReader<string>, buffer: { text: string }): Promise<SseMessage> {
  while (!buffer.text.includes("\n\n")) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error("The stream ended before the next event.")
    buffer.text += chunk.value
  }
  const end = buffer.text.indexOf("\n\n")
  const event = buffer.text.slice(0, end)
  buffer.text = buffer.text.slice(end + 2)
  const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n")
  // SAFETY: The test reads the fields of the message that it asserts.
  return JSON.parse(data) as SseMessage
}

function post(handler: ReturnType<typeof server>, body: unknown, headers: Record<string, string> = {}, route = "/mcp"): Promise<Response> {
  return handler(eventOf(new Request(`${origin}${route}`, {
    body: JSON.stringify(body),
    headers: { "accept": "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2025-11-25", ...headers },
    method: "POST",
  })))
}

describe("MCP elicitation on the wire", () => {
  it("does not elicit for an unissued session or a session from another endpoint", async () => {
    const handler = server()
    const initialized = await post(server({ route: "/other/mcp" }), { id: 1, jsonrpc: "2.0", method: "initialize", params: { capabilities: { elicitation: {} } } }, {}, "/other/mcp")
    for (const session of [`elicit-form.${crypto.randomUUID()}`, initialized.headers.get("mcp-session-id")!]) {
      const call = await post(handler, { id: 2, jsonrpc: "2.0", method: "tools/call", params: { arguments: { drop: "launch-notes" }, name: "share_drop" } }, { "mcp-session-id": session })
      const type = call.headers.get("content-type")
      if (type === "text/event-stream") await call.body?.cancel()
      expect(type).toContain("application/json")
      expect(await call.text()).toContain("MCP_ELICITATION_CLIENT_UNSUPPORTED")
    }
  })

  it("rejects a late answer after cancellation from the originating session", async () => {
    const handler = server()
    const init = { id: 1, jsonrpc: "2.0", method: "initialize", params: { capabilities: { elicitation: {} } } }
    const first = await post(handler, init)
    const second = await post(handler, init)
    const headers = { "mcp-session-id": first.headers.get("mcp-session-id")! }
    const other = { "mcp-session-id": second.headers.get("mcp-session-id")! }
    const call = await post(handler, { id: 2, jsonrpc: "2.0", method: "tools/call", params: { arguments: { drop: "launch-notes" }, name: "share_drop" } }, headers)
    const reader = call.body!.pipeThrough(new TextDecoderStream()).getReader()
    const prompt = await nextMessage(reader, { text: "" })
    const cancel = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } }
    expect((await post(handler, cancel, other)).status).toBe(202)
    expect((await post(handler, cancel, headers)).status).toBe(202)
    expect((await post(handler, { id: prompt.id, jsonrpc: "2.0", result: { action: "decline" } }, headers)).status).toBe(400)
    expect((await reader.read()).done).toBe(true)
  })

  it("sends a JSON-RPC error if the final tool result cannot be serialized", async () => {
    const handler = server({ tools: { invalid: defineMcpTool({
      description: "Return an unserializable result.",
      async handler(_input, { elicit }) {
        await elicit(Invite, { message: "Who?" })
        return { content: [{ type: "text", text: "Done" }], structuredContent: { value: 1n } }
      },
    }) } })
    const initialized = await post(handler, { id: 1, jsonrpc: "2.0", method: "initialize", params: { capabilities: { elicitation: {} } } })
    const headers = { "mcp-session-id": initialized.headers.get("mcp-session-id")! }
    const call = await post(handler, { id: 2, jsonrpc: "2.0", method: "tools/call", params: { name: "invalid" } }, headers)
    const reader = call.body!.pipeThrough(new TextDecoderStream()).getReader()
    const buffer = { text: "" }
    const request = await nextMessage(reader, buffer)
    expect((await post(handler, { id: request.id, jsonrpc: "2.0", result: { action: "decline" } }, headers)).status).toBe(202)
    expect(await nextMessage(reader, buffer)).toMatchObject({ id: 2, error: { code: -32603 } })
    expect((await reader.read()).done).toBe(true)
  })

  it("answers with SSE only when the handler elicits, and takes the answer as a new POST", async () => {
    const handler = server()
    const initialized = await post(handler, { id: 1, jsonrpc: "2.0", method: "initialize", params: { capabilities: { elicitation: {} }, clientInfo: { name: "raw", version: "1" }, protocolVersion: "2025-11-25" } })
    const session = initialized.headers.get("mcp-session-id")
    expect(session).toMatch(/^[\x21-\x7E]+$/)
    const headers = { "mcp-session-id": session! }

    const plain = await post(handler, { id: 2, jsonrpc: "2.0", method: "tools/call", params: { name: "list_drops" } }, headers)
    expect(plain.headers.get("content-type")).toContain("application/json")

    const call = await post(handler, { id: 3, jsonrpc: "2.0", method: "tools/call", params: { arguments: { drop: "launch-notes" }, name: "share_drop" } }, headers)
    expect(call.headers.get("content-type")).toContain("text/event-stream")
    const reader = call.body!.pipeThrough(new TextDecoderStream()).getReader()
    const buffer = { text: "" }
    const request = await nextMessage(reader, buffer)
    expect(request).toMatchObject({
      method: "elicitation/create",
      params: {
        message: "Who gets access to launch-notes?",
        mode: "form",
        requestedSchema: { properties: { email: { format: "email", type: "string" }, role: { enum: ["viewer", "editor"], type: "string" } }, required: ["email", "role"], type: "object" },
      },
    })
    expect(typeof request.id).toBe("string")

    const answered = await post(handler, { id: request.id, jsonrpc: "2.0", result: { action: "accept", content: { email: "sam@acme.dev", role: "viewer" } } }, headers)
    expect(answered.status).toBe(202)
    expect(await answered.text()).toBe("")

    expect(await nextMessage(reader, buffer)).toMatchObject({ id: 3, result: { isError: false, structuredContent: { drop: "launch-notes", email: "sam@acme.dev", role: "viewer" } } })
    expect((await reader.read()).done).toBe(true)
  })

  it("gives no session to a client without the elicitation capability", async () => {
    const initialized = await post(server(), { id: 1, jsonrpc: "2.0", method: "initialize", params: { capabilities: {}, clientInfo: { name: "raw", version: "1" }, protocolVersion: "2025-11-25" } })
    expect(initialized.headers.get("mcp-session-id")).toBeNull()
  })

  it("takes the answer only from the caller that the tool asked", async () => {
    const callers: Record<string, McpToolCaller> = {
      "Bearer sam": { clientId: "claude", clientName: "Claude", scopes: [], user: { id: "sam" } },
      "Bearer eve": { clientId: "claude", clientName: "Claude", scopes: [], user: { id: "eve" } },
    }
    const handler = server({ verify: async request => [undefined, callers[request.headers.get("authorization") ?? ""]!] as const })
    const initialized = await post(handler, { id: 1, jsonrpc: "2.0", method: "initialize", params: { capabilities: { elicitation: { form: {} } }, clientInfo: { name: "raw", version: "1" }, protocolVersion: "2025-11-25" } }, { authorization: "Bearer sam" })
    const sam = { "authorization": "Bearer sam", "mcp-session-id": initialized.headers.get("mcp-session-id")! }
    const call = await post(handler, { id: 2, jsonrpc: "2.0", method: "tools/call", params: { arguments: { drop: "launch-notes" }, name: "share_drop" } }, sam)
    const reader = call.body!.pipeThrough(new TextDecoderStream()).getReader()
    const buffer = { text: "" }
    const request = await nextMessage(reader, buffer)

    const answer = { id: request.id, jsonrpc: "2.0", result: { action: "accept", content: { email: "eve@acme.dev", role: "editor" } } }
    const stolen = await post(handler, answer, { ...sam, authorization: "Bearer eve" })
    expect(stolen.status).toBe(400)

    const second = await post(handler, { id: 1, jsonrpc: "2.0", method: "initialize", params: { capabilities: { elicitation: {} } } }, { authorization: "Bearer sam" })
    const otherSession = { ...sam, "mcp-session-id": second.headers.get("mcp-session-id")! }
    expect(otherSession["mcp-session-id"]).not.toBe(sam["mcp-session-id"])
    expect((await post(handler, answer, otherSession)).status).toBe(400)

    const declined = await post(handler, { id: request.id, jsonrpc: "2.0", result: { action: "decline" } }, sam)
    expect(declined.status).toBe(202)
    expect(await nextMessage(reader, buffer)).toMatchObject({ id: 2, result: { content: [{ text: "Did not share launch-notes: the person chose decline.", type: "text" }] } })
  })
})
