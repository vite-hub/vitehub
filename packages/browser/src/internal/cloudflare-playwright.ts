import { browserProviderError } from "../errors.ts"
import { cloudflareBrowserTerminated } from "./connections.ts"
import { attachPlaywrightBrowser } from "./playwright.ts"

import type { Browser } from "playwright-core"
import type { PlaywrightClient } from "../controllers/playwright.ts"
import type { CloudflareBrowserBindingConnection } from "./connections.ts"
import type { BrowserController } from "../types.ts"

interface CloudflarePlaywright {
  connect(binding: unknown, sessionId: string): Promise<Browser>
  launch(binding: unknown, options: { browser: "kitesurf" }): Promise<Browser>
}

async function loadCloudflare(): Promise<CloudflarePlaywright> {
  try {
    return await import("@cloudflare/playwright") as unknown as CloudflarePlaywright
  }
  catch (error) {
    throw browserProviderError("playwright", "load @cloudflare/playwright", { cause: error })
  }
}

export function cloudflarePlaywright(
  driver?: CloudflarePlaywright,
): BrowserController<PlaywrightClient, CloudflareBrowserBindingConnection> {
  return {
    features: { attachExistingSession: true },
    name: "playwright",
    async attach(connection) {
      const cloudflare = driver || await loadCloudflare()
      const browser = connection.engine === "kitesurf"
        ? await cloudflare.launch(connection.binding, { browser: "kitesurf" })
        : await cloudflare.connect(connection.binding, connection.sessionId)
      const attached = await attachPlaywrightBrowser(browser, connection)
      let released = false
      return {
        ...attached,
        async release() {
          if (released) return
          try {
            const cdp = await browser.newBrowserCDPSession()
            await cdp.send("Browser.close")
            connection[cloudflareBrowserTerminated] = true
            released = true
          }
          catch (error) {
            await browser.close().catch(() => {})
            throw error
          }
        },
      }
    },
  }
}
