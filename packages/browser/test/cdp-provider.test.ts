import { createServer } from "node:http"

import { afterEach, describe, expect, it } from "vitest"

import { hostBrowserDriver } from "../src/internal/host-driver.ts"
import { cdpBrowser } from "../src/providers/cdp.ts"

import type { Server } from "node:http"

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

async function devtoolsEndpoint() {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    response.setHeader("content-type", "application/json")
    if (request.url === "/json/version") {
      response.end(JSON.stringify({ webSocketDebuggerUrl: "ws://0.0.0.0:9222/devtools/browser/abc" }))
    }
    else if (request.url === "/json/new?about:blank" && request.method === "PUT") {
      response.end(JSON.stringify({ id: "target-1", type: "page" }))
    }
    else if (request.url === "/json/close/target-1") {
      response.end("Target is closing")
    }
    else {
      response.statusCode = 404
      response.end("{}")
    }
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new TypeError("Expected a TCP address")
  return { requests, url: `http://127.0.0.1:${address.port}` }
}

describe("cdpBrowser", () => {
  it("opens a page target on an HTTP endpoint and closes only that target", async () => {
    const endpoint = await devtoolsEndpoint()
    const session = await cdpBrowser({ url: endpoint.url }).open()

    expect(session.connection).toEqual({
      endpoint: `ws://${new URL(endpoint.url).host}/devtools/browser/abc`,
      kind: "cdp",
      preferredTargetId: "target-1",
    })
    await session.close()
    await session.close()
    expect(endpoint.requests).toEqual(["GET /json/version", "PUT /json/new?about:blank", "GET /json/close/target-1"])
  })

  it("uses a WebSocket endpoint as the browser connection", async () => {
    const session = await cdpBrowser({ url: "wss://browserless.example/chromium?token=secret" }).open()

    expect(session.connection).toEqual({ endpoint: "wss://browserless.example/chromium?token=secret", kind: "cdp" })
  })

  it("names the fix for a URL that is not a CDP endpoint, without the URL", () => {
    expect(() => cdpBrowser({ url: "ftp://token@host" })).toThrow(expect.objectContaining({
      code: "BROWSER_R0012",
      message: expect.not.stringContaining("token"),
    }))
  })

  it("reports an endpoint that does not answer as a provider error", async () => {
    await expect(cdpBrowser({ url: "http://127.0.0.1:1" }).open()).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
  })
})

describe("hostBrowserDriver", () => {
  it("connects to BROWSER_CDP_URL on every Node.js host", () => {
    expect(hostBrowserDriver("local", { BROWSER_CDP_URL: "ws://127.0.0.1:3000" }).name).toBe("cdp")
    expect(hostBrowserDriver("cdp", { BROWSER_CDP_URL: "ws://127.0.0.1:3000" }).name).toBe("cdp")
  })

  it("starts a local Chromium without BROWSER_CDP_URL", () => {
    expect(hostBrowserDriver("local", {}).name).toBe("local")
  })

  it("names BROWSER_CDP_URL when a remote-only host has none", () => {
    expect(() => hostBrowserDriver("cdp", {})).toThrow(expect.objectContaining({
      code: "BROWSER_R0014",
      fix: expect.stringContaining("BROWSER_CDP_URL"),
    }))
  })
})
