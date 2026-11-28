import { afterEach, describe, expect, it, vi } from "vitest"

import {
  isBrowserAvailable,
  runBrowserAction,
  runBrowserContent,
} from "../src/actions.ts"

import type { BrowserAvailability } from "../src/types.ts"

const runtimeConfig = vi.hoisted(() => ({ binding: "BROWSER", driver: "cloudflare" as string | undefined, engine: "chromium" }))
const availability = vi.hoisted(() => ({ current: { available: true } as BrowserAvailability }))
vi.mock("#vitehub/browser/runtime", () => ({ default: runtimeConfig, loadCloudflarePlaywright: undefined }))
vi.mock("#vitehub/browser/availability", () => ({
  get default() {
    return availability.current
  },
}))

const runtime = globalThis as typeof globalThis & { __env__?: Record<string, unknown> }

afterEach(() => {
  delete runtime.__env__
  runtimeConfig.driver = "cloudflare"
  availability.current = { available: true }
})

describe("Browser Run actions", () => {
  it("rejects actions when Browser is not configured", async () => {
    runtimeConfig.driver = undefined
    const response = await runBrowserAction("content", "https://example.com")
    expect(response.status).toBe(500)
  })

  it("names the preset and the fix when the build does not enable Browser", async () => {
    availability.current = {
      available: false,
      host: "vercel",
      reason: "Vercel has no built-in Browser Provider.",
      fix: "Deploy with the Cloudflare host and set `browser: true` in vitehub().",
    }
    expect(isBrowserAvailable()).toBe(false)

    const response = await runBrowserAction("content", "https://example.com")
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "BROWSER_UNAVAILABLE",
        message: "[vitehub:browser] Browser is not available on the vercel host. Vercel has no built-in Browser Provider. Deploy with the Cloudflare host and set `browser: true` in vitehub().",
        details: {
          fix: "Deploy with the Cloudflare host and set `browser: true` in vitehub().",
          host: "vercel",
          reason: "Vercel has no built-in Browser Provider.",
        },
      },
    })
  })

  it("runs Cloudflare Browser quick actions through the configured binding", async () => {
    const quickAction = vi.fn(async () => new Response("<html><title>ok</title></html>"))
    const binding = { quickAction }
    runtime.__env__ = { BROWSER: binding }

    const content = await runBrowserContent("https://example.com")
    expect(content).toEqual([undefined, "<html><title>ok</title></html>"])
    expect(quickAction).toHaveBeenCalledWith("content", { url: "https://example.com" })
  })

  it("returns the HTML of a Browser Run JSON result", async () => {
    runtime.__env__ = { BROWSER: { quickAction: async () => Response.json({ success: true, result: "<html><title>ok</title></html>", meta: { status: 200 } }) } }

    await expect(runBrowserContent("https://example.com")).resolves.toEqual([undefined, "<html><title>ok</title></html>"])
  })

  it("puts the Browser Run error in the message of a failed request", async () => {
    runtime.__env__ = { BROWSER: { quickAction: async () => Response.json({ success: false, errors: [{ code: 5005, message: "DNS resolution failed", detail: "net::ERR_NAME_NOT_RESOLVED at https://example.invalid" }] }, { status: 422 }) } }

    const [error] = await runBrowserContent("https://example.invalid")
    expect(error).toMatchObject({
      code: "BROWSER_CONTENT_FAILED",
      message: "The Browser content request failed with status 422: DNS resolution failed (net::ERR_NAME_NOT_RESOLVED at https://example.invalid)",
      status: 502,
    })
  })

  it("keeps the error of a request that did not reach Browser Run", async () => {
    const [missing] = await runBrowserContent("https://example.com")
    expect(missing).toMatchObject({
      code: "BROWSER_CONTENT_FAILED",
      message: "The Browser content request failed: [vitehub:browser] cloudflare could not resolve Browser Run binding \"BROWSER\".",
      cause: { code: "BROWSER_PROVIDER_ERROR" },
    })

    availability.current = { available: false, host: "node", reason: "Node has no Browser Provider.", fix: "Use the Cloudflare host." }
    const [unavailable] = await runBrowserContent("https://example.com")
    expect(unavailable).toMatchObject({ code: "BROWSER_CONTENT_FAILED", cause: { code: "BROWSER_UNAVAILABLE", details: { host: "node" } } })
  })

  it("does not resolve an inherited Browser binding", async () => {
    const quickAction = vi.fn(async () => new Response("unexpected"))
    runtime.__env__ = Object.create({ BROWSER: { quickAction } })

    const response = await runBrowserAction("content", "https://example.com")

    expect(response.status).toBe(500)
    expect(quickAction).not.toHaveBeenCalled()
  })

  it("does not recurse forever while inspecting cyclic action input", async () => {
    const input: Record<string, unknown> = { url: "https://example.com" }
    input.options = input
    const quickAction = vi.fn(async () => new Response("complete"))
    runtime.__env__ = { BROWSER: { quickAction } }

    const response = await runBrowserAction("content", input)

    expect(response.status).toBe(200)
    expect(quickAction).toHaveBeenCalledWith("content", input)
  })

  it("returns raw quick action responses for binary actions", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png" },
    })
    const binding = { quickAction: vi.fn(async () => response) }
    runtime.__env__ = { BROWSER: binding }

    const result = await runBrowserAction("screenshot", { url: "https://example.com" })
    expect(result).toBe(response)
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it("reports non-ok quick action responses as Browser errors", async () => {
    const binding = { quickAction: vi.fn(async () => new Response("nope", { status: 500 })) }
    runtime.__env__ = { BROWSER: binding }

    const [error] = await runBrowserContent("https://example.com")
    expect(error).toMatchObject({ code: "BROWSER_CONTENT_FAILED", status: 502 })
  })

  it("cancels non-ok quick action response bodies", async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel, start() {} }), { status: 500 })
    runtime.__env__ = { BROWSER: { quickAction: vi.fn(async () => response) } }

    const [error] = await runBrowserContent("https://example.com")
    expect(error).toMatchObject({
      code: "BROWSER_CONTENT_FAILED",
      fix: expect.stringContaining("`error.cause`"),
      message: "The Browser content request failed with status 500.",
    })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([false, true])("clears the action timer after a provider result, rejected: %s", async (reject) => {
    vi.useFakeTimers()
    try {
      runtime.__env__ = { BROWSER: { quickAction: async () => {
        if (reject) throw new Error("provider failed")
        return new Response("complete")
      } } }

      const response = await runBrowserAction("content", "https://example.com")

      expect(response.status).toBe(reject ? 500 : 200)
      expect(vi.getTimerCount()).toBe(0)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("bounds stalled Browser Run actions", async () => {
    vi.useFakeTimers()
    try {
      runtime.__env__ = { BROWSER: { quickAction: async () => await new Promise(() => {}) } }

      const action = runBrowserAction("content", "https://example.com")
      await vi.advanceTimersByTimeAsync(30_000)

      await expect(action).resolves.toMatchObject({ status: 500 })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it.each(["complete", "reject", "stall"])("cancels late action responses when cleanup will %s", async (cleanup) => {
    vi.useFakeTimers()
    try {
      const cancel = vi.fn(() => {
        if (cleanup === "reject") return Promise.reject(new Error("cancel failed"))
        if (cleanup === "stall") return new Promise<void>(() => {})
      })
      const response = new Response(new ReadableStream({ cancel }))
      let resolveResponse!: (response: Response) => void
      const provider = new Promise<Response>((resolve) => { resolveResponse = resolve })
      runtime.__env__ = { BROWSER: { quickAction: () => provider } }

      const action = runBrowserAction("content", "https://example.com")
      await vi.advanceTimersByTimeAsync(30_000)
      await expect(action).resolves.toMatchObject({ status: 500 })
      expect(cancel).not.toHaveBeenCalled()

      resolveResponse(response)
      await vi.advanceTimersByTimeAsync(0)

      expect(cancel).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("bounds stalled Browser Run response bodies", async () => {
    vi.useFakeTimers()
    try {
      const cancel = vi.fn()
      const response = new Response(new ReadableStream({ cancel, start() {} }))
      runtime.__env__ = { BROWSER: { quickAction: async () => response } }

      const content = runBrowserContent("https://example.com")
      await vi.advanceTimersByTimeAsync(30_000)

      expect((await content)[0]).toMatchObject({ code: "BROWSER_CONTENT_FAILED", cause: { code: "BROWSER_PROVIDER_ERROR" } })
      expect(cancel).toHaveBeenCalledOnce()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("does not wait for or leak rejecting response cancellation", async () => {
    vi.useFakeTimers()
    try {
      const cancel = vi.fn(async () => {
        throw new Error("cancel failed")
      })
      const response = new Response(new ReadableStream({
        cancel,
        start() {},
      }))
      runtime.__env__ = { BROWSER: { quickAction: async () => response } }

      const content = runBrowserContent("https://example.com")
      await vi.advanceTimersByTimeAsync(30_000)

      expect((await content)[0]).toMatchObject({ code: "BROWSER_CONTENT_FAILED" })
      expect(cancel).toHaveBeenCalledOnce()
      await vi.runAllTimersAsync()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("does not wait for hanging response cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const response = new Response(new ReadableStream({ cancel, start() {} }), { status: 500 })
    runtime.__env__ = { BROWSER: { quickAction: async () => response } }

    expect((await runBrowserContent("https://example.com"))[0]?.message).toBe("The Browser content request failed with status 500.")
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("allows provider-supported actions to run longer than the default bound", async () => {
    vi.useFakeTimers()
    try {
      runtime.__env__ = { BROWSER: { quickAction: async () => {
        await new Promise(resolve => setTimeout(resolve, 31_000))
        return new Response("complete")
      } } }

      const action = runBrowserContent({ actionTimeout: 60_000, url: "https://example.com" })
      await vi.advanceTimersByTimeAsync(31_000)

      await expect(action).resolves.toEqual([undefined, "complete"])
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("allows cumulative provider navigation and action timeout phases", async () => {
    vi.useFakeTimers()
    try {
      runtime.__env__ = { BROWSER: { quickAction: async () => {
        await new Promise(resolve => setTimeout(resolve, 331_000))
        return new Response("complete")
      } } }

      const action = runBrowserContent({ actionTimeout: 300_000, goToOptions: { timeout: 60_000 }, url: "https://example.com" })
      await vi.advanceTimersByTimeAsync(331_000)

      await expect(action).resolves.toEqual([undefined, "complete"])
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("preserves timeout accumulation for shared nested options", async () => {
    vi.useFakeTimers()
    try {
      runtime.__env__ = { BROWSER: { quickAction: async () => {
        await new Promise(resolve => setTimeout(resolve, 45_000))
        return new Response("complete")
      } } }
      const shared = { timeout: 20_000 }

      const action = runBrowserContent({ firstOptions: shared, secondOptions: shared, url: "https://example.com" })
      await vi.advanceTimersByTimeAsync(45_000)

      await expect(action).resolves.toEqual([undefined, "complete"])
    }
    finally {
      vi.useRealTimers()
    }
  })
})
