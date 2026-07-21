import { describe, expectTypeOf, it } from "vitest"

import { createBrowser, type BrowserSessionRef } from "../src/index.ts"
import { playwright, type PlaywrightClient } from "../src/controllers/playwright.ts"
import { cloudflareBrowser } from "../src/providers/cloudflare.ts"
import { localBrowser } from "../src/providers/local.ts"
import { hubBrowser } from "../src/vite.ts"

describe("published Browser types", () => {
  it("infers native Playwright callback clients for both providers", async () => {
    const local = createBrowser({ provider: localBrowser({ executablePath: "/usr/bin/chromium" }) })
    const cloudflare = createBrowser({ provider: cloudflareBrowser() })

    await local.withSession(session => session.use(playwright(), (client) => {
      expectTypeOf(client).toEqualTypeOf<PlaywrightClient>()
    }))
    await cloudflare.withSession(session => session.use(playwright(), (client) => {
      expectTypeOf(client).toEqualTypeOf<PlaywrightClient>()
    }))
  })

  it("returns opaque refs and a Vite plugin", async () => {
    const browser = createBrowser({ provider: cloudflareBrowser() })
    const session = await browser.open()
    expectTypeOf(session.handoff({ audience: "run-1", mode: "live" })).resolves.toEqualTypeOf<BrowserSessionRef>()
    expectTypeOf(hubBrowser()).toMatchTypeOf<ReturnType<typeof hubBrowser>>()
  })
})
