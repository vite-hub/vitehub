import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { consoleRequest } from "../src/console/runtime/server/access.ts"
import { consoleRequestURL } from "../src/console/runtime/server/request.ts"

describe("Console request header reconstruction", () => {
  it("reads the URL and the headers from the same request", () => {
    const headers: Record<string, string> = { "authorization": "Bearer token", "host": "console.example", "origin": "https://console.example" }
    const event = {
      req: {
        headers: { get: (name: string) => headers[name] ?? null },
        method: "GET",
        url: "/_vitehub/console",
      },
    }

    const request = consoleRequest(event)
    expect(request.url).toBe(consoleRequestURL(event).toString())
    expect(request.headers.get("authorization")).toBe("Bearer token")
    expect(request.headers.get("origin")).toBe("https://console.example")
    expect(request.headers.get("host")).toBe("console.example")
  })

  it("copies headers from a Headers-like object created in another realm", () => {
    const headers = runInNewContext("({ get: name => name === 'authorization' ? 'Bearer token' : null })")
    const request = consoleRequest({ req: { headers, url: "/_vitehub/console" } })

    expect(request.headers.get("authorization")).toBe("Bearer token")
  })

  it("keeps an empty host header", () => {
    const event = {
      req: {
        headers: { get: (name: string) => name === "host" ? "" : null },
        method: "GET",
        url: "/_vitehub/console",
      },
    }

    const request = consoleRequest(event)
    expect(request.headers.get("host")).toBe("")
    expect(consoleRequestURL(event).hostname).toBe("localhost")
  })

  it("reads the forwarded URL headers", () => {
    const headers: Record<string, string> = { "host": "internal.example", "x-forwarded-host": "console.example", "x-forwarded-proto": "https" }
    const event = {
      req: {
        headers: { get: (name: string) => headers[name] ?? null },
        method: "GET",
        url: "/_vitehub/console",
      },
    }

    expect(consoleRequestURL(event).toString()).toBe("https://console.example/_vitehub/console")
    expect(consoleRequest(event).url).toBe("https://console.example/_vitehub/console")
  })
})
