import { afterEach, describe, expect, it, vi } from "vitest"

import {
  runBrowserAction,
  runBrowserContent,
} from "../src/actions.ts"

const runtimeConfig = vi.hoisted(() => ({ binding: "BROWSER", engine: "chromium", provider: "cloudflare" as string | undefined }))
vi.mock("#vitehub/browser/runtime", () => ({ default: runtimeConfig }))

const runtime = globalThis as typeof globalThis & { __env__?: Record<string, unknown> }

afterEach(() => {
  delete runtime.__env__
  runtimeConfig.provider = "cloudflare"
})

describe("Browser Run actions", () => {
  it("rejects actions when Browser is not configured", async () => {
    runtimeConfig.provider = undefined
    const [error, response] = await runBrowserAction("content", "https://example.com")

    expect(error?.code).toBe("BROWSER_RUNTIME_NOT_CONFIGURED")
    expect(response).toBeUndefined()
  })

  it("runs Cloudflare Browser quick actions through the configured binding", async () => {
    const quickAction = vi.fn(async () => new Response("<html><title>ok</title></html>"))
    const binding = { quickAction }
    runtime.__env__ = { BROWSER: binding }

    const [error, content] = await runBrowserContent("https://example.com")

    expect(error).toBeNull()
    expect(content).toBe("<html><title>ok</title></html>")
    expect(quickAction).toHaveBeenCalledWith("content", { url: "https://example.com" })
  })

  it("returns raw quick action responses for binary actions", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png" },
    })
    const binding = { quickAction: vi.fn(async () => response) }
    runtime.__env__ = { BROWSER: binding }

    const [error, result] = await runBrowserAction("screenshot", { url: "https://example.com" })

    expect(error).toBeNull()
    expect(result).toBe(response)
  })

  it("reports non-ok quick action responses as Browser errors", async () => {
    const binding = { quickAction: vi.fn(async () => new Response("nope", { status: 500 })) }
    runtime.__env__ = { BROWSER: binding }

    const [error, content] = await runBrowserContent("https://example.com")

    expect(error?.code).toBe("BROWSER_PROVIDER_ERROR")
    expect(content).toBeUndefined()
  })

  it("bounds stalled Browser Run actions", async () => {
    vi.useFakeTimers()
    try {
      runtime.__env__ = { BROWSER: { quickAction: async () => await new Promise(() => {}) } }

      const action = runBrowserAction("content", "https://example.com")
      await vi.advanceTimersByTimeAsync(30_000)

      await expect(action).resolves.toMatchObject([{ code: "BROWSER_PROVIDER_ERROR" }, undefined])
    }
    finally {
      vi.useRealTimers()
    }
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

      await expect(action).resolves.toEqual([null, "complete"])
    }
    finally {
      vi.useRealTimers()
    }
  })
})
