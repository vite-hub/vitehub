import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"

import { callMcpTool } from "../src/mcp.ts"
import type { MCPTransport } from "../src/mcp.ts"

type ToolCallResult = Record<string, unknown>

async function startMcpServer(response: "json" | "sse", result: ToolCallResult, options: { parameterHeader?: boolean, stall?: "tools/list" | "tools/call" } = {}) {
  const calls: Array<{ arguments?: unknown, authorization?: string, name?: unknown, parameterHeader?: string | string[] }> = []
  const server = createServer(async (request, reply) => {
    if (request.method !== "POST") {
      reply.writeHead(405).end()
      return
    }
    let body = ""
    for await (const chunk of request) body += chunk
    const message = JSON.parse(body) as { id?: number, method: string, params?: Record<string, unknown> }
    if (message.id === undefined) {
      reply.writeHead(202).end()
      return
    }
    if (message.method === options.stall) return
    let payload: unknown
    if (message.method === "initialize") {
      payload = {
        capabilities: { tools: {} },
        protocolVersion: message.params?.protocolVersion,
        serverInfo: { name: "test", version: "1.0.0" },
      }
    }
    else if (message.method === "server/discover") {
      payload = { capabilities: { tools: {} }, supportedVersions: [request.headers["mcp-protocol-version"]] }
    }
    else if (message.method === "tools/list") {
      payload = { tools: [{
        name: "threads_get",
        inputSchema: { type: "object", properties: {
          id: { type: "string", ...(options.parameterHeader ? { "x-mcp-header": "Thread-Id" } : {}) },
        } },
      }] }
    }
    else if (message.method === "tools/call") {
      calls.push({ arguments: message.params?.arguments, authorization: request.headers.authorization, name: message.params?.name })
      if (options.parameterHeader) calls[calls.length - 1]!.parameterHeader = request.headers["mcp-param-thread-id"]
      payload = options.parameterHeader && request.headers["mcp-param-thread-id"] !== "thread-1"
        ? { content: [{ text: "Missing parameter header", type: "text" }], isError: true }
        : result
    }
    else {
      reply.writeHead(200, { "content-type": "application/json" })
      reply.end(JSON.stringify({ error: { code: -32601, message: "Method not found" }, id: message.id, jsonrpc: "2.0" }))
      return
    }
    if (options.parameterHeader) payload = { ...payload as Record<string, unknown>, resultType: "complete" }
    const json = JSON.stringify({ id: message.id, jsonrpc: "2.0", result: payload })
    if (response === "sse") {
      reply.writeHead(200, { "content-type": "text/event-stream" })
      reply.end(`event: message\ndata: ${json}\n\n`)
      return
    }
    reply.writeHead(200, { "content-type": "application/json" })
    reply.end(json)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  servers.push(server)
  const { port } = server.address() as AddressInfo
  return { calls, url: `http://127.0.0.1:${port}/mcp` }
}

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections()
  })))
})

describe("callMcpTool", () => {
  it.each(["resolution", "discovery", "execution", "result"])("returns error tuples for hostile thrown values during %s", async (stage) => {
    const proxy = Proxy.revocable({}, {})
    proxy.revoke()
    const hostileValues = [proxy.proxy, { [Symbol.toPrimitive]() { throw new Error("coercion failed") } }]
    for (const thrown of hostileValues) {
      const fail = () => { throw thrown }
      const client = {
        close: vi.fn(async () => undefined),
        tools: async () => {
          if (stage === "discovery") fail()
          return {
            lookup: {
              execute: async () => {
                if (stage === "execution") fail()
                return { get content() { return fail() } }
              },
            },
          }
        },
      }
      const [error, value] = await callMcpTool(() => stage === "resolution" ? fail() : client, "lookup")
      expect(value).toBeNull()
      expect(error).toBeInstanceOf(Error)
      expect(error?.message).toBe("[vitehub] MCP tool call failed.")
      expect(error?.cause).toBe(thrown)
      expect(client.close).toHaveBeenCalledTimes(stage === "resolution" ? 0 : 1)
    }
  })

  it("preserves Error instances and converts ordinary thrown values", async () => {
    const original = new Error("original")
    await expect(callMcpTool(() => { throw original }, "lookup")).resolves.toEqual([original, null])
    const [error, value] = await callMcpTool(() => { throw "plain failure" }, "lookup")
    expect(value).toBeNull()
    expect(error).toMatchObject({ message: "plain failure", cause: "plain failure" })
  })

  it.each(["json", "sse"] as const)("calls a Streamable HTTP tool that answers with %s", async (response) => {
    const thread = { id: "thread-1", title: "Forecast export" }
    const { calls, url } = await startMcpServer(response, { content: [{ text: JSON.stringify({ thread }), type: "text" }] })
    const productlane = () => ({ transport: { headers: { Authorization: "Bearer token" }, type: "http" as const, url } })

    const [error, value] = await callMcpTool(productlane, "threads_get", { id: "thread-1" })

    expect(error).toBeNull()
    expect(value).toEqual({ thread })
    expect(calls).toEqual([{ arguments: { id: "thread-1" }, authorization: "Bearer token", name: "threads_get" }])
  })

  it("discovers modern HTTP tool parameter headers before calling", async () => {
    const { calls, url } = await startMcpServer("json", { content: [{ text: "ok", type: "text" }] }, { parameterHeader: true })

    await expect(callMcpTool({ protocolVersionDiscovery: true, transport: { type: "http", url } }, "threads_get", { id: "thread-1" })).resolves.toEqual([null, "ok"])
    expect(calls).toEqual([{ arguments: { id: "thread-1" }, authorization: undefined, name: "threads_get", parameterHeader: "thread-1" }])
  })

  it.each(["tools/list", "tools/call"] as const)("times out a stalled HTTP %s request", async (stall) => {
    const { url } = await startMcpServer("json", {}, { stall })
    const [error, value] = await callMcpTool({ transport: { type: "http", url } }, "threads_get", {}, { timeout: 50 })

    expect(error).toMatchObject({ name: "TimeoutError" })
    expect(value).toBeNull()
  })

  it.each(["discovery", "execution"] as const)("bounds fallback %s even when the client ignores cancellation", async (stage) => {
    const execute = vi.fn((_args: unknown, _options: { abortSignal: AbortSignal }) => new Promise<never>(() => {}))
    const tools = vi.fn(() => stage === "discovery" ? new Promise<never>(() => {}) : Promise.resolve({ lookup: { execute } }))
    const client = { close: vi.fn(async () => undefined), tools }
    const [error, value] = await callMcpTool(() => client, "lookup", {}, { timeout: 10 })

    expect(error).toMatchObject({ name: "TimeoutError" })
    expect(value).toBeNull()
    expect(client.close).toHaveBeenCalledOnce()
    if (stage === "discovery") expect(execute).not.toHaveBeenCalled()
    else expect(execute.mock.calls[0]?.[1]).toMatchObject({ abortSignal: expect.objectContaining({ aborted: true }) })
  })

  it("honors caller cancellation during fallback execution", async () => {
    const controller = new AbortController()
    const execute = vi.fn(async () => {
      controller.abort(new Error("Cancelled by caller"))
      return await new Promise<never>(() => {})
    })
    const client = { close: vi.fn(async () => undefined), tools: async () => ({ lookup: { execute } }) }

    const [error, value] = await callMcpTool(client, "lookup", {}, { signal: controller.signal, timeout: 10_000 })
    expect(error?.message).toBe("Cancelled by caller")
    expect(value).toBeNull()
    expect(client.close).not.toHaveBeenCalled()
  })

  it.each(["caller", "configuration"] as const)("honors %s cancellation during MCP initialization", async (source) => {
    const caller = new AbortController()
    const configuration = new AbortController()
    const transport: MCPTransport = {
      close: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      start: vi.fn(async () => await new Promise<void>(() => {})),
    }
    const connecting = callMcpTool({
      initializationOptions: { signal: configuration.signal, timeout: 1_000 },
      transport,
    }, "lookup", {}, { signal: caller.signal })

    await vi.waitFor(() => expect(transport.start).toHaveBeenCalledOnce())
    const controller = source === "caller" ? caller : configuration
    controller.abort(new Error("Connection cancelled"))
    const [error, value] = await connecting

    expect(error?.message).toContain("initialization was aborted")
    expect(value).toBeNull()
    expect(transport.close).toHaveBeenCalledOnce()
  })

  it("does not open a connection when the caller has already cancelled", async () => {
    const controller = new AbortController()
    const reason = new Error("Already cancelled")
    controller.abort(reason)
    const transport: MCPTransport = {
      close: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
    }

    await expect(callMcpTool({ transport }, "lookup", {}, { signal: controller.signal })).resolves.toEqual([reason, null])
    expect(transport.start).not.toHaveBeenCalled()
  })

  it("returns structured content before text content", async () => {
    const { url } = await startMcpServer("json", {
      content: [{ text: "Thread thread-1", type: "text" }],
      structuredContent: { id: "thread-1" },
    })

    await expect(callMcpTool({ transport: { type: "http", url } }, "threads_get")).resolves.toEqual([null, { id: "thread-1" }])
  })

  it("returns plain text content that is not JSON", async () => {
    const { url } = await startMcpServer("sse", { content: [{ text: "No thread found.", type: "text" }] })

    await expect(callMcpTool({ transport: { type: "http", url } }, "threads_get")).resolves.toEqual([null, "No thread found."])
  })

  it("returns tool errors and unreachable servers as error tuples", async () => {
    const { url } = await startMcpServer("json", { content: [{ text: "Unknown thread", type: "text" }], isError: true })

    const [toolError, toolValue] = await callMcpTool({ transport: { type: "http", url } }, "threads_get")
    expect(toolValue).toBeNull()
    expect(toolError).toMatchObject({ code: "MCP_TOOL_CALL_FAILED", message: "[vitehub] MCP tool \"threads_get\" failed: Unknown thread" })

    const [connectionError, connectionValue] = await callMcpTool({ transport: { type: "http", url: "http://127.0.0.1:9/mcp" } }, "threads_get")
    expect(connectionValue).toBeNull()
    expect(connectionError).toBeInstanceOf(Error)
  })

  it("closes clients from server functions and keeps borrowed clients open", async () => {
    const execute = vi.fn(async () => ({ content: [{ text: "{\"ok\":true}", type: "text" }] }))
    const client = { close: vi.fn(async () => undefined), tools: vi.fn(async () => ({ lookup: { execute } })) }

    await expect(callMcpTool(client, "lookup", { query: "x" })).resolves.toEqual([null, { ok: true }])
    expect(client.close).not.toHaveBeenCalled()
    await expect(callMcpTool(() => client, "lookup")).resolves.toEqual([null, { ok: true }])
    expect(client.close).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith({ query: "x" }, expect.objectContaining({ toolCallId: expect.any(String) }))

    const [missing] = await callMcpTool(client, "missing")
    expect(missing).toMatchObject({ code: "MCP_TOOL_NOT_FOUND" })
  })
})
