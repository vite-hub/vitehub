import { once } from "node:events"
import { createServer } from "node:http"
import type { RequestListener } from "node:http"
import { afterEach, expect, it } from "vitest"
import { startChatGPTTransport } from "../src/internal/chatgpt-transport.ts"

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture(handler: RequestListener) {
  const server = createServer(handler)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() }))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a test port")
  const credential = {
    accessToken: "private-chatgpt-grant", api: `http://127.0.0.1:${address.port}/v1`, expiresAt: Date.now() + 60_000,
    clientInfo: { name: "App", title: "App", version: "1" },
  }
  const abort = new AbortController()
  const transport = await startChatGPTTransport(credential, abort.signal)
  cleanup.push(transport.close)
  const headers = { authorization: `Bearer ${transport.key}` }
  return { transport, credential, abort, headers }
}

it("streams Responses with runtime-owned authentication, attribution and token redaction", async () => {
  const received: unknown[] = []
  const test = await fixture(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    received.push({ url: request.url, headers: request.headers, body })
    response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "request-1", authorization: "private-chatgpt-grant" })
    response.write('data: {"text":"private-chat')
    response.end('gpt-grant"}\n\n')
  })
  expect(test.transport.key).not.toBe(test.credential.accessToken)
  const response = await fetch(`${test.transport.url}/responses`, {
    method: "POST", headers: { ...test.headers, originator: "App", "content-type": "application/json", "x-codex-turn-state": "state", cookie: "unrelated" },
    body: '{"model":"test","stream":true}',
  })
  expect(response.status).toBe(200)
  expect(response.headers.get("x-request-id")).toBe("request-1")
  expect(response.headers.has("authorization")).toBe(false)
  expect(await response.text()).toBe('data: {"text":"[REDACTED]"}\n\n')
  expect(received).toEqual([expect.objectContaining({ url: "/v1/responses", body: '{"model":"test","stream":true}', headers: expect.objectContaining({
    authorization: `Bearer ${test.credential.accessToken}`, originator: "App", "x-codex-turn-state": "state",
  }) })])
  expect(JSON.stringify(received)).not.toContain("unrelated")
})

it("rejects unauthenticated, expired and unsupported requests without forwarding them", async () => {
  let requests = 0
  const test = await fixture((_request, response) => { requests++; response.end("models") })
  expect((await fetch(`${test.transport.url}/models`)).status).toBe(401)
  for (const [path, method] of [["/responses/compact", "POST"], ["//attacker.test/responses", "POST"], ["/models", "POST"], ["/responses", "GET"]]) {
    expect((await fetch(`${test.transport.url}${path}`, { method, headers: test.headers })).status).toBe(404)
  }
  expect(await (await fetch(`${test.transport.url}/models?client_version=test`, { headers: test.headers })).text()).toBe("models")
  test.credential.expiresAt = Date.now() - 1
  expect((await fetch(`${test.transport.url}/responses`, { method: "POST", headers: test.headers })).status).toBe(401)
  expect(requests).toBe(1)
})

it("does not follow upstream redirects or forward their destination", async () => {
  const test = await fixture((_request, response) => response.writeHead(307, { location: "https://attacker.test/", "set-cookie": "secret" }).end())
  const response = await fetch(`${test.transport.url}/responses`, { method: "POST", headers: test.headers, redirect: "manual" })
  expect(response.status).toBe(307)
  expect(response.headers.has("location")).toBe(false)
  expect(response.headers.has("set-cookie")).toBe(false)
})

it("delivers short SSE events before the upstream response ends", async () => {
  let finish = () => {}
  const test = await fixture((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write("data: hi\n\n")
    finish = () => response.end("data: done\n\n")
  })
  try {
    const response = await fetch(`${test.transport.url}/responses`, { method: "POST", headers: test.headers })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: hi\n\n")
    finish()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: done\n\n")
    expect((await reader.read()).done).toBe(true)
  }
  finally { finish() }
})

it("closes an active upstream stream on abort and refuses subsequent requests", async () => {
  let markUpstreamClosed = () => {}
  const upstreamClosed = new Promise<void>((resolve) => { markUpstreamClosed = resolve })
  const test = await fixture((_request, response) => {
    response.on("close", markUpstreamClosed)
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(`data: ${"x".repeat(200)}\n\n`)
  })
  const response = await fetch(`${test.transport.url}/responses`, { method: "POST", headers: test.headers })
  const body = response.text()
  const failedBody = expect(body).rejects.toThrow()
  test.abort.abort()
  await test.transport.close()
  await upstreamClosed
  await failedBody
  await expect(fetch(`${test.transport.url}/models`, { headers: test.headers })).rejects.toThrow()
  await test.transport.close()
})
