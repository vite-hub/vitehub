import { afterEach, describe, expect, it, vi } from "vitest"

import {
  defineBrowser,
  executeBrowserDefinition,
  runBrowser,
} from "../src/runtime.ts"

import type { BrowserClient } from "../src/types.ts"

const runtimeConfig = vi.hoisted(() => ({ binding: "BROWSER", engine: "chromium", provider: "cloudflare" as string | undefined }))
vi.mock("#vitehub/browser/runtime", () => ({ default: runtimeConfig }))

const runtime = globalThis as typeof globalThis & { __env__?: Record<string, unknown> }

afterEach(() => {
  delete runtime.__env__
  runtimeConfig.provider = "cloudflare"
})

describe("Browser Definitions", () => {
  it("reports an unconfigured runtime before opening a default binding", async () => {
    runtimeConfig.provider = undefined
    const definition = defineBrowser(async (_input, { browser }) => {
      await browser.open()
    })

    await expect(executeBrowserDefinition(definition, undefined)).rejects.toMatchObject({
      code: "BROWSER_RUNTIME_NOT_CONFIGURED",
    })
  })

  it("returns an error-first result when a definition cannot run", async () => {
    const name: string = "missing"
    const [error, value] = await runBrowser(name)

    expect(error?.code).toBe("BROWSER_DEFINITION_NOT_FOUND")
    expect(value).toBeUndefined()
  })

  it("lets definitions use rendered content", async () => {
    const quickAction = vi.fn(async () => new Response(
      "<html><meta property=\"og:image\" content=\"https://example.com/card.png\"></html>",
    ))
    runtime.__env__ = { BROWSER: { quickAction } }
    const definition = defineBrowser(async (input: { url: string }, { browser }) => {
      return await browser.content(input.url)
    })

    await expect(executeBrowserDefinition(definition, { url: "https://example.com" })).resolves.toContain("card.png")

    expect(quickAction).toHaveBeenCalledWith("content", { url: "https://example.com" })
  })

  it("runs generic browser actions without exposing the provider method", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png" },
    })
    const quickAction = vi.fn(async () => response)
    runtime.__env__ = { BROWSER: { quickAction } }
    const definition = defineBrowser(async (input: { url: string }, { browser }) => {
      return await browser.run("screenshot", input)
    })

    await expect(executeBrowserDefinition(definition, { url: "https://example.com" })).resolves.toBe(response)

    expect(quickAction).toHaveBeenCalledWith("screenshot", { url: "https://example.com" })
  })

  it("bounds stalled Browser Definition quick actions", async () => {
    vi.useFakeTimers()
    try {
      runtime.__env__ = { BROWSER: { quickAction: async () => await new Promise(() => {}) } }
      const definition = defineBrowser(async (input: { url: string }, { browser }) => {
        return await browser.content(input.url)
      })

      const invocation = executeBrowserDefinition(definition, { url: "https://example.com" })
      const result = expect(invocation).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
      await vi.advanceTimersByTimeAsync(30_000)

      await result
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("closes definition-owned page sessions", async () => {
    const release = vi.fn(async () => {})
    const close = vi.fn(async () => {})
    const client = {
      open: vi.fn(async () => ({
        id: "browser-1",
        attach: vi.fn(async () => ({
          client: {
            on: vi.fn(() => () => {}),
            send: vi.fn(async (method: string) => method === "Target.getTargets"
              ? { targetInfos: [{ targetId: "page", type: "page" }] }
              : method === "Target.attachToTarget" ? { sessionId: "page-1" } : {}),
          },
          release,
        })),
        close,
        inspect: vi.fn(() => ({ features: { liveHandoff: false }, id: "browser-1", provider: "test", state: "released" })),
      })),
    } as unknown as BrowserClient
    const definition = defineBrowser(async (_input, { browser }) => {
      await browser.open()
      return "ok"
    })

    await expect(executeBrowserDefinition(definition, undefined, { client })).resolves.toBe("ok")
    expect(release).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it("releases the controller before closing a session when page setup fails", async () => {
    const release = vi.fn(async () => {})
    const close = vi.fn(async () => {})
    const client = {
      open: vi.fn(async () => ({
        id: "browser-1",
        attach: vi.fn(async () => ({
          client: {
            on: vi.fn(() => () => {}),
            send: vi.fn(async () => ({ targetInfos: [] })),
          },
          release,
        })),
        close,
        inspect: vi.fn(),
      })),
    } as unknown as BrowserClient
    const definition = defineBrowser(async (_input, { browser }) => {
      await browser.open()
    })

    await expect(executeBrowserDefinition(definition, undefined, { client })).rejects.toMatchObject({
      code: "BROWSER_PROVIDER_ERROR",
    })
    expect(release).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]!)
  })

  it("does not retry session cleanup after a successful handler", async () => {
    const release = vi.fn(async () => {
      throw new Error("release failed")
    })
    const close = vi.fn(async () => {})
    const client = {
      open: vi.fn(async () => ({
        id: "browser-1",
        attach: vi.fn(async () => ({
          client: {
            on: vi.fn(() => () => {}),
            send: vi.fn(async (method: string) => method === "Target.getTargets"
              ? { targetInfos: [{ targetId: "page", type: "page" }] }
              : method === "Target.attachToTarget" ? { sessionId: "page-1" } : {}),
          },
          release,
        })),
        close,
        inspect: vi.fn(),
      })),
    } as unknown as BrowserClient
    const definition = defineBrowser(async (_input, { browser }) => {
      await browser.open()
      return "ok"
    })

    await expect(executeBrowserDefinition(definition, undefined, { client })).rejects.toThrow("release failed")
    expect(release).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })
})
