import { afterEach, describe, expect, it, vi } from "vitest"

import { executeHttpRequest } from "../src/http-request.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("HTTP request", () => {
  it("applies cookies to fetch while redacting them from summaries", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), {
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
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe("https://portal.example.com/inventory?cached=1&region=eu")
    expect(new Headers(init.headers).get("cookie")).toBe("locale=en; sid=secret; workspace=portal")
    expect(result.summary).toMatchObject({
      cookies: "redacted",
      hasQuery: true,
      headers: "redacted",
      url: "https://portal.example.com/inventory",
    })
  })

  it("retries safe requests without retrying writes", async () => {
    const unavailable = new Error("unavailable")
    const fetch = vi.fn()
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce(new Response("ok"))
    vi.stubGlobal("fetch", fetch)

    await expect(executeHttpRequest({ url: "https://example.com" }, { responseType: "text" }))
      .resolves.toMatchObject({ data: "ok", status: 200 })
    expect(fetch).toHaveBeenCalledTimes(2)

    fetch.mockClear()
    fetch.mockRejectedValueOnce(unavailable)
    await expect(executeHttpRequest({ method: "POST", url: "https://example.com" }))
      .rejects.toBe(unavailable)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("retries only transient response statuses", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok"))
    vi.stubGlobal("fetch", fetch)

    await expect(executeHttpRequest({ url: "https://example.com/missing" }, { responseType: "text" }))
      .rejects.toMatchObject({ message: "[vitehub] HTTP request failed with status 404." })
    expect(fetch).toHaveBeenCalledOnce()

    await expect(executeHttpRequest({ url: "https://example.com/transient" }, { responseType: "text" }))
      .resolves.toMatchObject({ data: "ok", status: 200 })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it("interrupts an active request with the caller's exact abort reason", async () => {
    const reason = new Error("caller stopped")
    const controller = new AbortController()
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    }))
    vi.stubGlobal("fetch", fetch)

    const request = executeHttpRequest(
      { url: "https://example.com" },
      { signal: controller.signal },
    )
    controller.abort(reason)

    await expect(request).rejects.toBe(reason)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("keeps cancellation active while consuming the response body", async () => {
    const reason = new Error("stop response body")
    const controller = new AbortController()
    let bodyStarted!: () => void
    const started = new Promise<void>(resolve => bodyStarted = resolve)
    let fetchSignal: AbortSignal | undefined
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined
      return new Response(new ReadableStream({
        start(stream) {
          bodyStarted()
          fetchSignal?.addEventListener("abort", () => stream.error(fetchSignal?.reason), { once: true })
        },
      }))
    })
    vi.stubGlobal("fetch", fetch)

    const request = executeHttpRequest(
      { url: "https://example.com/stream" },
      { responseType: "text", signal: controller.signal },
    )
    await started
    controller.abort(reason)

    await expect(request).rejects.toBe(reason)
    expect(fetchSignal?.aborted).toBe(true)
  })

  it("interrupts timed out fetches without retaining a timer", async () => {
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    }))
    vi.stubGlobal("fetch", fetch)

    const error = await executeHttpRequest({ timeout: 1, url: "https://example.com" }).catch(error => error)

    expect(error).toMatchObject({ name: "AbortError" })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.every(call => call[1]?.signal?.aborted)).toBe(true)
  })

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2_147_483_648,
  ])("rejects invalid timeout %s before dispatch", async (timeout) => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)

    await expect(executeHttpRequest({ timeout, url: "https://example.com" })).rejects.toThrow("positive finite number")
    expect(fetch).not.toHaveBeenCalled()
  })
})
