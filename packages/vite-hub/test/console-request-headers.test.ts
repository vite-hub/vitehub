import { describe, expect, it } from "vitest"

import { installStandardContext } from "../src/runtime/h3.ts"
import { consoleRequest } from "../src/console/runtime/server/access.ts"
import { consoleRequestURL } from "../src/console/runtime/server/request.ts"

import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"

function event(url: string, headers: Record<string, string> = {}): ConsoleRequestEvent {
  return { "~standard": { vendor: "test", req: new Request(url, { headers }), res: { headers: new Headers() } } }
}

describe("Console request URL", () => {
  it("passes the Standard Context request to authorization and runtime contexts", () => {
    const standard = event("http://console.example/_vitehub/console", { authorization: "Bearer token" })
    expect(consoleRequest(standard)).toBe(standard["~standard"].req)
  })

  it("applies the host and scheme that a proxy forwards", () => {
    const forwarded = event("http://internal.example/_vitehub/console", { "x-forwarded-host": "console.example, proxy", "x-forwarded-proto": "https" })
    expect(consoleRequestURL(forwarded).toString()).toBe("https://console.example/_vitehub/console")
    expect(consoleRequestURL(event("http://internal.example/_vitehub/console")).toString()).toBe("http://internal.example/_vitehub/console")
  })

  it("keeps the mounted base of an H3 1 request", () => {
    const h3V1 = {
      node: {
        req: { headers: { host: "console.example" }, method: "GET", originalUrl: "/portal/_vitehub/console", url: "/_vitehub/console" },
        res: {},
      },
    }
    installStandardContext(h3V1)
    expect(consoleRequestURL(h3V1).toString()).toBe("http://console.example/portal/_vitehub/console")
  })
})
