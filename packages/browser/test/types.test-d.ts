import { describe, expectTypeOf, it } from "vitest"

import {
  createBrowser,
  defineBrowser,
  type BrowserPageSession,
  type BrowserSessionRef,
  useBrowserSession,
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
      expectTypeOf(useBrowserSession(browser)).resolves.toEqualTypeOf<BrowserPageSession>()
      return input.url
    })
  })

  it("returns opaque refs and a Vite plugin", async () => {
    const browser = createBrowser({ provider: cloudflareBrowser() })
    const session = await browser.open()
    expectTypeOf(session.handoff({ audience: "run-1", mode: "live" })).resolves.toEqualTypeOf<BrowserSessionRef>()
    expectTypeOf(hubBrowser()).toMatchTypeOf<ReturnType<typeof hubBrowser>>()
  })
})
