import { describe, expect, it } from "vitest"

import { consoleRequest } from "../src/console/runtime/server/access.ts"
import { consoleRequestURL } from "../src/console/runtime/server/request.ts"

describe("Console request header reconstruction", () => {
  it("uses the same per-header fallbacks as URL reconstruction", () => {
    const event = {
      method: "GET",
      req: {
        headers: { get: (name: string) => name === "authorization" ? "Bearer token" : null },
        url: "/_vitehub/console",
      },
      headers: { get: (name: string) => name === "origin" ? "https://console.example" : null },
      node: { req: { headers: { host: "console.example" } } },
    }

    const request = consoleRequest(event)
    expect(request.url).toBe(consoleRequestURL(event).toString())
    expect(request.headers.get("authorization")).toBe("Bearer token")
    expect(request.headers.get("origin")).toBe("https://console.example")
    expect(request.headers.get("host")).toBe("console.example")
  })

  it("keeps an empty higher-precedence header instead of falling back", () => {
    const event = {
      method: "GET",
      req: {
        headers: { get: (name: string) => name === "host" ? "" : null },
        url: "/_vitehub/console",
      },
      node: { req: { headers: { host: "console.example" } } },
    }

    const request = consoleRequest(event)
    expect(request.headers.get("host")).toBe("")
    expect(consoleRequestURL(event).hostname).toBe("localhost")
  })

  it("keeps an empty event header instead of falling back to Node headers", () => {
    const event = {
      method: "GET",
      req: { url: "/_vitehub/console" },
      headers: { get: (name: string) => name === "host" ? "" : null },
      node: { req: { headers: { host: "console.example" } } },
    }

    const request = consoleRequest(event)
    expect(request.headers.get("host")).toBe("")
    expect(consoleRequestURL(event).hostname).toBe("localhost")
  })

  it("combines forwarded URL headers across request containers", () => {
    const event = {
      method: "GET",
      req: {
        headers: { get: (name: string) => name === "authorization" ? "Bearer token" : null },
        url: "/_vitehub/console",
      },
      headers: { get: (name: string) => ({ "x-forwarded-host": "console.example", "x-forwarded-proto": "https" })[name] ?? null },
      node: { req: { headers: { host: "internal.example" } } },
    }

    expect(consoleRequestURL(event).toString()).toBe("https://console.example/_vitehub/console")
    expect(consoleRequest(event).url).toBe("https://console.example/_vitehub/console")
  })
})
