import { describe, expectTypeOf, it } from "vitest"

import {
  createBrowser,
  defineBrowser,
  type BrowserDownload,
  type BrowserPage,
  type BrowserPageSession,
  type BrowserRunResult,
  type BrowserSessionRef,
  runBrowserContent,
} from "../src/index.ts"
import { playwright, type PlaywrightClient } from "../src/controllers/playwright.ts"
import { cloudflareBrowser } from "../src/providers/cloudflare.ts"
import { localBrowser } from "../src/providers/local.ts"
import { hubBrowser } from "../src/vite.ts"

describe("published Browser types", () => {
  it("infers native Playwright controller leases for both providers", async () => {
    const local = createBrowser({ provider: localBrowser({ executablePath: "/usr/bin/chromium" }) })
    const cloudflare = createBrowser({ provider: cloudflareBrowser() })

    const localSession = await local.open()
    expectTypeOf((await localSession.attach(playwright())).client).toEqualTypeOf<PlaywrightClient>()
    const cloudflareSession = await cloudflare.open()
    expectTypeOf((await cloudflareSession.attach(playwright())).client).toEqualTypeOf<PlaywrightClient>()
  })

  it("types imperative definition-scoped sessions", () => {
    defineBrowser(async (input: { url: string }, { browser }) => {
      expectTypeOf(browser.content(input.url)).resolves.toEqualTypeOf<string>()
      expectTypeOf(browser.open()).resolves.toEqualTypeOf<BrowserPageSession>()
      return input.url
    })
  })

  it("types Browser Run quick actions", () => {
    expectTypeOf(runBrowserContent("https://example.com")).resolves.toEqualTypeOf<BrowserRunResult<string>>()
  })

  it("exports a Browser Download event shape without requiring Playwright types", () => {
    expectTypeOf<BrowserDownload>().toEqualTypeOf<{ url(): string }>()
  })

  it("exports documented page operations without requiring Playwright types", () => {
    expectTypeOf<BrowserPage["goto"]>().parameters.toEqualTypeOf<[url: string, options?: Record<string, unknown>]>()
    expectTypeOf<BrowserPage["title"]>().returns.toEqualTypeOf<Promise<string>>()
    expectTypeOf<ReturnType<BrowserPage["locator"]>["screenshot"]>().returns.toEqualTypeOf<Promise<Uint8Array>>()
  })

  it("types error-first Browser Definition results", () => {
    expectTypeOf<BrowserRunResult<{ title: string }>>().toEqualTypeOf<
      [error: null, value: { title: string }]
      | [error: import("@vite-hub/runtime").ViteHubError<`BROWSER_${string}`>, value: undefined]
    >()
  })

  it("returns opaque refs and a Vite plugin", async () => {
    const browser = createBrowser({ provider: cloudflareBrowser() })
    const session = await browser.open()
    expectTypeOf(session.handoff({ audience: "run-1", mode: "live" })).resolves.toEqualTypeOf<BrowserSessionRef>()
    expectTypeOf(hubBrowser()).toMatchTypeOf<ReturnType<typeof hubBrowser>>()
    expectTypeOf(hubBrowser({ engine: "chromium" })).toMatchTypeOf<ReturnType<typeof hubBrowser>>()
  })
})
