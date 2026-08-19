import { describe, expect, it, vi } from "vitest"

import {
  runBrowserAction,
  runBrowserContent,
} from "../src/actions.ts"

describe("Browser Run actions", () => {
  it("runs Cloudflare Browser quick actions through the configured binding", async () => {
    const quickAction = vi.fn(async () => new Response("<html><title>ok</title></html>"))
    const binding = { quickAction }

    const [error, content] = await runBrowserContent("https://example.com", { binding })

    expect(error).toBeNull()
    expect(content).toBe("<html><title>ok</title></html>")
    expect(quickAction).toHaveBeenCalledWith("content", { url: "https://example.com" })
  })

  it("returns raw quick action responses for binary actions", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png" },
    })
    const binding = { quickAction: vi.fn(async () => response) }

    const [error, result] = await runBrowserAction("screenshot", { url: "https://example.com" }, { binding })

    expect(error).toBeNull()
    expect(result).toBe(response)
  })

  it("reports non-ok quick action responses as Browser errors", async () => {
    const binding = { quickAction: vi.fn(async () => new Response("nope", { status: 500 })) }

    const [error, content] = await runBrowserContent("https://example.com", { binding })

    expect(error?.code).toBe("BROWSER_PROVIDER_ERROR")
    expect(content).toBeUndefined()
  })
})
