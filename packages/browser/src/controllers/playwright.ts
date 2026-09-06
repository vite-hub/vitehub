import { loadChromium } from "#vitehub/browser/chromium"
import { browserProviderError } from "../errors.ts"
import { attachPlaywrightBrowser } from "../internal/playwright.ts"

import type {
  Browser,
  BrowserContext,
  BrowserType,
  Page,
} from "playwright-core"
import type { BrowserController } from "../types.ts"
import type { PlaywrightBrowserConnection } from "../internal/connections.ts"

export interface PlaywrightClient {
  browser: Browser
  context: BrowserContext
  page: Page
}

export interface PlaywrightControllerOptions {
  chromium?: Pick<BrowserType, "connectOverCDP">
  cloudflare?: {
    connect(binding: unknown, sessionId: string): Promise<Browser>
    launch(binding: unknown, options: { browser: "kitesurf" }): Promise<Browser>
  }
}

function asPlaywrightBrowser(browser: unknown): Browser {
  // SAFETY: Both Playwright packages expose the Browser surface consumed by ViteHub's controller.
  return browser as Browser
}

async function loadCloudflare(): Promise<NonNullable<PlaywrightControllerOptions["cloudflare"]>> {
  try {
    const cloudflare = await import("@cloudflare/playwright")
    return {
      async connect(binding, sessionId) {
        // SAFETY: Cloudflare supplies the Browser Worker binding accepted by its Playwright adapter.
        const browser = await cloudflare.connect(binding as never, sessionId)
        return asPlaywrightBrowser(browser)
      },
      async launch(binding, options) {
        // SAFETY: Cloudflare supplies the Browser endpoint accepted by its Playwright adapter.
        const browser = await cloudflare.launch(binding as never, options)
        return asPlaywrightBrowser(browser)
      },
    }
  }
  catch (error) {
    throw browserProviderError("playwright", "load @cloudflare/playwright", { cause: error })
  }
}

export function playwright(options: PlaywrightControllerOptions = {}): BrowserController<PlaywrightClient, PlaywrightBrowserConnection> {
  return {
    features: { attachExistingSession: true },
    name: "playwright",
    async attach(connection) {
      const browser = connection.kind === "cloudflare-binding"
        ? connection.engine === "kitesurf"
          ? await (options.cloudflare || await loadCloudflare()).launch(connection.binding, { browser: "kitesurf" })
          : await (options.cloudflare || await loadCloudflare()).connect(connection.binding, connection.sessionId)
        : await (options.chromium || await loadChromium()).connectOverCDP(
            connection.endpoint,
            connection.headers ? { headers: connection.headers } : {},
          )
      return await attachPlaywrightBrowser(browser, connection)
    },
  }
}

export type { PlaywrightBrowserConnection } from "../internal/connections.ts"
