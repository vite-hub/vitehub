import { afterEach, describe, expect, it, vi } from "vitest"

import {
  defineBrowser,
  executeBrowserDefinition,
  runBrowser,
} from "../src/runtime.ts"

import type { BrowserClient } from "../src/types.ts"

const runtime = globalThis as typeof globalThis & { __env__?: Record<string, unknown> }

afterEach(() => {
  delete runtime.__env__
})

describe("Browser Definitions", () => {
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
})
