import { describe, expect, it, vi } from "vitest"

import {
  defineBrowser,
  executeBrowserDefinition,
  runBrowser,
} from "../src/runtime.ts"

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
    const definition = defineBrowser(async (input: { url: string }, { browser }) => {
      return await browser.content(input.url)
    })

    await expect(executeBrowserDefinition(
      definition,
      { url: "https://example.com" },
      { binding: { quickAction } },
    )).resolves.toContain("card.png")

    expect(quickAction).toHaveBeenCalledWith("content", { url: "https://example.com" })
  })

  it("runs generic browser actions without exposing the provider method", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png" },
    })
    const quickAction = vi.fn(async () => response)
    const definition = defineBrowser(async (input: { url: string }, { browser }) => {
      return await browser.run("screenshot", input)
    })

    await expect(executeBrowserDefinition(
      definition,
      { url: "https://example.com" },
      { binding: { quickAction } },
    )).resolves.toBe(response)

    expect(quickAction).toHaveBeenCalledWith("screenshot", { url: "https://example.com" })
  })
})
