import { describe, expect, it, vi } from "vitest"

import {
  defineBrowser,
  executeBrowserDefinition,
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
