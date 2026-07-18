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

  it("does not retry caller cancellation and preserves the abort reason", async () => {
    const controller = new AbortController()
    const reason = new Error("request cancelled")
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) return reject(new Error("missing fetch signal"))
      if (signal.aborted) return reject(signal.reason)
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    }))
    vi.stubGlobal("fetch", fetch)

    const request = executeHttpRequest({
      abortSignal: controller.signal,
      timeout: 10_000,
      url: "https://portal.example.com/inventory",
    })
    controller.abort(reason)

    await expect(request).rejects.toBe(reason)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("preserves the abort reason while decoding the response", async () => {
    const controller = new AbortController()
    const reason = new Error("response cancelled")
    const response = new Response()
    const text = vi.spyOn(response, "text").mockImplementation(async () => await new Promise<string>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
    }))
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response))

    const request = executeHttpRequest({
      abortSignal: controller.signal,
      url: "https://portal.example.com/inventory",
    })
    while (!text.mock.calls.length) await Promise.resolve()
    controller.abort(reason)

    await expect(request).rejects.toBe(reason)
  })

  it("does not start a request for an already aborted caller", async () => {
    const controller = new AbortController()
    const reason = new Error("already cancelled")
    controller.abort(reason)
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)

    await expect(executeHttpRequest({
      abortSignal: controller.signal,
      url: "https://portal.example.com/inventory",
    })).rejects.toBe(reason)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("still retries non-cancellation GET failures", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(new Response("\"ok\""))
    vi.stubGlobal("fetch", fetch)

    await expect(executeHttpRequest({
      url: "https://portal.example.com/inventory",
    })).resolves.toMatchObject({ data: "ok" })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
