import { afterEach, describe, expect, it, vi } from "vitest"

import { executeHttpRequest } from "../src/http-request.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("HTTP request", () => {
  it("applies cookies to fetch while redacting them from summaries", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }))
    vi.stubGlobal("fetch", fetch)

    const result = await executeHttpRequest({
      cookies: {
        sid: "secret",
        workspace: "portal",
      },
      headers: {
        authorization: "Bearer token",
        cookie: "locale=en",
      },
      query: { region: "eu" },
      url: "https://portal.example.com/inventory?cached=1",
    })

    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://portal.example.com/inventory?cached=1&region=eu")
    expect(new Headers(init.headers).get("cookie")).toBe("locale=en; sid=secret; workspace=portal")
    expect(result.summary).toMatchObject({
      cookies: "redacted",
      hasQuery: true,
      headers: "redacted",
      url: "https://portal.example.com/inventory",
    })
  })
})
