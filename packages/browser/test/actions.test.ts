import { afterEach, describe, expect, it, vi } from "vitest"

import {
  runBrowserAction,
  runBrowserContent,
} from "../src/actions.ts"
import { runKitesurfAction } from "../src/internal/kitesurf-actions.ts"

const runtime = globalThis as typeof globalThis & { __env__?: Record<string, unknown> }

afterEach(() => {
  delete runtime.__env__
})

describe("Browser Run actions", () => {
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

  it("captures Kitesurf screenshots through ViteHub CDP", async () => {
    const commands: string[] = []
    class FakeSocket extends EventTarget {
      readyState = 1
      accept() {}
      close() {
        this.readyState = 3
        this.dispatchEvent(new Event("close"))
      }

      send(value: string) {
        const request = JSON.parse(value) as { id: number, method: string }
        commands.push(request.method)
        const result = request.method === "Target.getTargets"
          ? { targetInfos: [{ targetId: "page", type: "page" }] }
          : request.method === "Target.attachToTarget"
            ? { sessionId: "page-session" }
            : request.method === "Page.getFrameTree"
              ? { frameTree: { frame: { id: "frame" } } }
              : request.method === "Page.getLayoutMetrics"
                ? { cssContentSize: { height: 20, width: 10 } }
                : request.method === "Page.captureScreenshot"
                  ? { data: btoa("png") }
                  : {}
        this.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({ id: request.id, result }),
        }))
      }
    }

    const socket = new FakeSocket()
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0]) => ({ webSocket: socket }) as unknown as Response)

    const response = await runKitesurfAction({ fetch }, "screenshot", {
      html: "<h1>ViteHub</h1>",
      screenshotOptions: { fullPage: true },
      viewport: { height: 720, width: 1280 },
    })

    await expect(response.arrayBuffer()).resolves.toEqual(Uint8Array.from([112, 110, 103]).buffer)
    expect(String(fetch.mock.calls[0]![0])).toContain("browser=kitesurf")
    expect(commands).toContain("Page.setDocumentContent")
    expect(commands).toContain("Page.captureScreenshot")
  })
})
