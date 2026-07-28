import { browserProviderError } from "../errors.ts"
import { cloudflareBrowserTerminated } from "./connections.ts"
import { attachPlaywrightBrowser } from "./playwright.ts"

import type { Browser } from "playwright-core"
import type { PlaywrightClient } from "../controllers/playwright.ts"
import type { CloudflareBrowserBindingConnection } from "./connections.ts"
import type { BrowserController } from "../types.ts"

interface CloudflarePlaywright {
  connect(binding: unknown, sessionId: string): Promise<Browser>
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
      const browser = await (driver || await loadCloudflare()).connect(connection.binding, connection.sessionId)
      const attached = await attachPlaywrightBrowser(browser, connection)
      let released = false
      return {
        ...attached,
        async release() {
          if (released) return
          try {
            const cdp = await browser.newBrowserCDPSession()
            const termination = cdp.send("Browser.close")
            connection[cloudflareBrowserTerminated] = true
            released = true
            void Promise.resolve(termination).catch(() => {})
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
