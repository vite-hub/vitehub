import { describe, expect, it } from "vitest"
import { callDocsTool } from "../src/docs-mcp.ts"

const result = { content: [{ text: "pages", type: "text" }] }

function stream(body: string): typeof fetch {
  return async () => new Response(body, { headers: { "content-type": "text/event-stream" } })
}

function event(message: unknown): string {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`
}

describe("callDocsTool", () => {
  it("reads a JSON answer", async () => {
    const send: typeof fetch = async () => Response.json({ id: 1, jsonrpc: "2.0", result })
    expect(await callDocsTool("list-pages", {}, send)).toEqual({ ...result, isError: false })
  })

  it("reads a stream with one event", async () => {
    expect(await callDocsTool("list-pages", {}, stream(event({ id: 1, jsonrpc: "2.0", result })))).toEqual({ ...result, isError: false })
  })

  it("reads the result after a progress notification", async () => {
    const body = event({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1, progressToken: 1 } })
      + event({ id: 1, jsonrpc: "2.0", result })
    expect(await callDocsTool("list-pages", {}, stream(body))).toEqual({ ...result, isError: false })
  })

  it("reads a result split across data lines, with CRLF and a priming event", async () => {
    const json = JSON.stringify({ id: 1, jsonrpc: "2.0", result }, null, 2).split("\n").map(line => `data:${line}`).join("\r\n")
    expect(await callDocsTool("list-pages", {}, stream(`id: 0\r\ndata:\r\n\r\n: keep-alive\r\n\r\n${json}\r\n\r\n`))).toEqual({ ...result, isError: false })
  })

  it("ignores an answer to another request", async () => {
    const body = event({ id: 2, jsonrpc: "2.0", result: { content: [{ text: "other", type: "text" }] } })
      + event({ id: 1, jsonrpc: "2.0", result })
    expect(await callDocsTool("list-pages", {}, stream(body))).toEqual({ ...result, isError: false })
  })

  it("says so when the stream has only notifications", async () => {
    const body = event({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1, progressToken: 1 } })
    expect(await callDocsTool("list-pages", {}, stream(body))).toEqual({
      content: [{ text: "The docs server did not answer the request.", type: "text" }],
      isError: true,
    })
  })

  it("says so when an event is not JSON", async () => {
    expect(await callDocsTool("list-pages", {}, stream("data: {\n\n"))).toEqual({
      content: [{ text: "The docs server sent an answer that is not JSON-RPC.", type: "text" }],
      isError: true,
    })
  })

  it("returns the error of the matching answer", async () => {
    const body = event({ error: { code: -32602, message: "Unknown page." }, id: 1, jsonrpc: "2.0" })
    expect(await callDocsTool("get-page", { path: "/x" }, stream(body))).toEqual({
      content: [{ text: "Unknown page.", type: "text" }],
      isError: true,
    })
  })
})
