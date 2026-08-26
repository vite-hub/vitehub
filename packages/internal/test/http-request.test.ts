import { afterEach, describe, expect, it, vi } from "vitest"

import {
  defaultHttpMaxResponseBytes,
  defaultHttpRequestTimeout,
  executeHttpRequest,
  maximumHttpMaxResponseBytes,
  normalizeHttpRequest,
} from "../src/http-request.ts"

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

  it("reports response status without waiting for body cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 404 }))
    vi.stubGlobal("fetch", fetch)

    await expect(executeHttpRequest({ timeout: 10, url: "https://example.com/missing" }, { responseType: "text" }))
      .rejects.toMatchObject({ message: "[vitehub] HTTP request failed with status 404." })
    expect(fetch).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("rejects a streamed response above the configured byte limit without retrying", async () => {
    const cancel = vi.fn()
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      cancel,
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1234"))
      },
    })))
    vi.stubGlobal("fetch", fetch)

    await expect(executeHttpRequest({ maxResponseBytes: 3, url: "https://example.com/large" }, { responseType: "text" }))
      .rejects.toThrow("response exceeds")
    expect(fetch).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("rejects an oversized Content-Length before reading and cancels the body", async () => {
    const cancel = vi.fn()
    const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": "4" },
    }))
    vi.stubGlobal("fetch", fetch)

    await expect(executeHttpRequest({ maxResponseBytes: 3, url: "https://example.com/declared-large" }))
      .rejects.toThrow("configured 3-byte limit")
    expect(fetch).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([
    ["declared", { "content-length": "4" }],
    ["streamed", undefined],
  ])("reports a %s size failure without waiting for stream cancellation", async (_, headers) => {
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      cancel,
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1234"))
      },
    }), { headers }))
    vi.stubGlobal("fetch", fetch)

    await expect(executeHttpRequest({ maxResponseBytes: 3, timeout: 10, url: "https://example.com/large" }))
      .rejects.toThrow("configured 3-byte limit")
    expect(fetch).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("allows an oversized Content-Length on an empty HEAD response", async () => {
    const fetch = vi.fn(async () => new Response(null, {
      headers: { "content-length": "4" },
    }))
    vi.stubGlobal("fetch", fetch)

    await expect(executeHttpRequest({ maxResponseBytes: 3, method: "HEAD", url: "https://example.com/head" }))
      .resolves.toMatchObject({ data: undefined })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("counts decoded bytes instead of rejecting an encoded Content-Length", async () => {
    const fetch = vi.fn(async () => new Response("123", {
      headers: {
        "content-encoding": "gzip",
        "content-length": "4",
      },
    }))
    vi.stubGlobal("fetch", fetch)

    await expect(executeHttpRequest({ maxResponseBytes: 3, url: "https://example.com/compressed" }, { responseType: "text" }))
      .resolves.toMatchObject({ data: "123" })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("counts streamed bytes when Content-Length is missing or understated", async () => {
    for (const contentLength of [undefined, "2"]) {
      const cancel = vi.fn()
      const headers = contentLength ? { "content-length": contentLength } : undefined
      const fetch = vi.fn(async () => new Response(new ReadableStream({
        cancel,
        start(controller) {
          controller.enqueue(new TextEncoder().encode("1234"))
        },
      }), { headers }))
      vi.stubGlobal("fetch", fetch)

      await expect(executeHttpRequest({ maxResponseBytes: 3, url: "https://example.com/stream" }, { responseType: "text" }))
        .rejects.toThrow("configured 3-byte limit")
      expect(cancel).toHaveBeenCalledOnce()
    }
  })

  it("decodes bounded text and JSON through the Node WHATWG Response path", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("hello"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
    vi.stubGlobal("fetch", fetch)

    await expect(executeHttpRequest({ maxResponseBytes: 5, url: "https://example.com/text" }, { responseType: "text" }))
      .resolves.toMatchObject({ data: "hello" })
    await expect(executeHttpRequest({ maxResponseBytes: 11, url: "https://example.com/json" }))
      .resolves.toMatchObject({ data: { ok: true } })
  })

  it("decodes bounded arrayBuffer and blob responses without bypassing the reader", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
      .mockResolvedValueOnce(new Response("blob", { headers: { "content-type": "text/custom" } }))
    vi.stubGlobal("fetch", fetch)

    const arrayBuffer = await executeHttpRequest({ maxResponseBytes: 3, url: "https://example.com/buffer" }, { responseType: "arrayBuffer" })
    expect(arrayBuffer.data).toBeInstanceOf(ArrayBuffer)
    if (!(arrayBuffer.data instanceof ArrayBuffer)) throw new TypeError("Expected an ArrayBuffer response")
    expect(new Uint8Array(arrayBuffer.data)).toEqual(new Uint8Array([1, 2, 3]))
    const blob = await executeHttpRequest({ maxResponseBytes: 4, url: "https://example.com/blob" }, { responseType: "blob" })
    expect(blob.data).toBeInstanceOf(Blob)
    if (!(blob.data instanceof Blob)) throw new TypeError("Expected a Blob response")
    expect(blob.data.type).toBe("text/custom")
    await expect(blob.data.text()).resolves.toBe("blob")
  })

  it("does not retry deterministic response schema failures", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: false })))
    vi.stubGlobal("fetch", fetch)

    await expect(executeHttpRequest({ url: "https://example.com/schema" }, {
      schema: {
        "~standard": {
          validate: () => ({ issues: ["expected ok"] }),
        },
      },
    })).rejects.toThrow("Invalid HTTP response")
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("normalizes safe outbound defaults", () => {
    expect(normalizeHttpRequest({ url: "https://example.com" })).toMatchObject({
      maxResponseBytes: defaultHttpMaxResponseBytes,
      timeout: defaultHttpRequestTimeout,
    })
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

  it("cancels response readers when response-body decoding times out", async () => {
    const cancel = vi.fn()
    const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel })))
    vi.stubGlobal("fetch", fetch)

    const error = await executeHttpRequest({ timeout: 1, url: "https://example.com/slow-body" }, { responseType: "text" })
      .catch(error => error)

    expect(error).toMatchObject({ name: "AbortError" })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledTimes(2)
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

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    maximumHttpMaxResponseBytes + 1,
  ])("rejects invalid maxResponseBytes %s before dispatch", async (maxResponseBytes) => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)

    await expect(executeHttpRequest({ maxResponseBytes, url: "https://example.com" })).rejects.toThrow("positive safe integer")
    expect(fetch).not.toHaveBeenCalled()
  })
})
