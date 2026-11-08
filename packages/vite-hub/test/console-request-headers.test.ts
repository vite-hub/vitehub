import { describe, expect, it } from "vitest"

import { H3Event } from "h3"

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

  it("keeps the mounted base of an H3 2 request", () => {
    const h3 = new H3Event(new Request("http://console.example/portal/_vitehub/console"))
    h3.url = new URL("http://console.example/_vitehub/console")
    installStandardContext(h3)
    expect(consoleRequestURL(h3).toString()).toBe("http://console.example/portal/_vitehub/console")
  })
})
