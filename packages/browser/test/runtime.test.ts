import { describe, expect, it, vi } from "vitest"

import {
  defineBrowser,
  executeBrowserDefinition,
  runBrowser,
} from "../src/runtime.ts"
import { createBrowser } from "../src/index.ts"

import type {
  BrowserController,
  BrowserProvider,
} from "../src/types.ts"
import type { PlaywrightClient } from "../src/controllers/playwright.ts"

interface TestConnection {
  value: string
}

function fixture() {
  const close = vi.fn(async () => {})
  const release = vi.fn(async () => {})
  const page = { goto: vi.fn(async () => {}) }
  const client = {
    browser: { close: vi.fn() },
    context: {},
    page,
  } as unknown as PlaywrightClient
  const provider: BrowserProvider<TestConnection> = {
    features: { liveHandoff: false },
    isolation: "provider",
    name: "fixture",
    async open() {
      return {
        close,
        connection: { value: "ready" },
        id: "provider-session",
      }
    },
  }
  const controller: BrowserController<PlaywrightClient, TestConnection> = {
    async attach(connection) {
      expect(connection.value).toBe("ready")
      return { client, release }
    },
    features: { attachExistingSession: false },
    name: "playwright",
  }
  return {
    browser: createBrowser({ provider }),
    client,
    close,
    controller,
    page,
    release,
  }
}

describe("Browser Definitions", () => {
  it("returns an error-first result when a definition cannot run", async () => {
    const name: string = "missing"
    const [error, value] = await runBrowser(name)

    expect(error?.code).toBe("BROWSER_DEFINITION_NOT_FOUND")
    expect(value).toBeUndefined()
  })

  it("provides imperative sessions and closes them after the definition", async () => {
    const { browser, close, controller, page, release } = fixture()
    const definition = defineBrowser(async (input: { url: string }, { browser }) => {
      const session = await browser.open()
      await session.page.goto(input.url)
      return session.id
    })

    await expect(executeBrowserDefinition(definition, { url: "https://example.com" }, {
      client: browser,
      controller,
    })).resolves.toMatch(/^browser_/)

    expect(page.goto).toHaveBeenCalledWith("https://example.com")
    expect(release).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it("lets definitions use Browser Run content without opening a Playwright session", async () => {
    const { browser, close, controller, release } = fixture()
    const quickAction = vi.fn(async () => new Response(
      "<html><meta property=\"og:image\" content=\"https://example.com/card.png\"></html>",
    ))
    const definition = defineBrowser(async (input: { url: string }, { browser }) => {
      return await browser.content(input.url)
    })

    await expect(executeBrowserDefinition(definition, { url: "https://example.com" }, {
      action: { binding: { quickAction } },
      client: browser,
      controller,
    })).resolves.toContain("card.png")

    expect(quickAction).toHaveBeenCalledWith("content", { url: "https://example.com" })
    expect(release).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it("closes sessions when the definition throws", async () => {
    const { browser, close, controller, release } = fixture()
    const definition = defineBrowser(async (_input: undefined, { browser }) => {
      await browser.open()
      throw new Error("render failed")
    })

    await expect(executeBrowserDefinition(definition, undefined, {
      client: browser,
      controller,
    })).rejects.toThrow("render failed")

    expect(release).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it("lets definitions close sessions early without double cleanup", async () => {
    const { browser, close, controller, release } = fixture()
    const definition = defineBrowser(async (_input: undefined, { browser }) => {
      const session = await browser.open()
      await session.close()
    })

    await executeBrowserDefinition(definition, undefined, {
      client: browser,
      controller,
    })

    expect(release).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })
})
