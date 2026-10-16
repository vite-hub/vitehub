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
})
