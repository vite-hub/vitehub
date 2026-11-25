import { describe, expect, it } from "vitest"

import { clientRequest } from "../src/runtime/client-request.ts"
import clientRequestPlugin from "../src/runtime/client-request-plugin.ts"

describe("clientRequestPlugin", () => {
  it("wraps fetch once when two packages install it", async () => {
    const seen: string[] = []
    const h3 = { fetch: async (request: Request) => {
      seen.push(clientRequest(new Request("http://localhost/api/items")).url)
      return new Response(request.url)
    } }
    const nitroApp = { h3 }
    const original = h3.fetch
    clientRequestPlugin(nitroApp)
    const wrapped = h3.fetch
    clientRequestPlugin(nitroApp)
    expect(wrapped).not.toBe(original)
    expect(h3.fetch).toBe(wrapped)
    await expect((await h3.fetch(new Request("https://app.example.com/page"))).text()).resolves.toBe("https://app.example.com/page")
    expect(seen).toEqual(["https://app.example.com/page"])
  })
})
