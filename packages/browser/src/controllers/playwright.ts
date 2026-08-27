import { browserProviderError } from "../errors.ts"
import { attachPlaywrightBrowser } from "../internal/playwright.ts"
import { importBrowserOptionalPeer } from "../internal/optional-peer.ts"

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

async function loadChromium(): Promise<Pick<BrowserType, "connectOverCDP">> {
  try {
    return (await importBrowserOptionalPeer<typeof import("playwright-core")>("playwright-core")).chromium
  }
  catch (error) {
    throw browserProviderError("playwright", "load playwright-core", { cause: error })
  }
}

async function loadCloudflare(): Promise<NonNullable<PlaywrightControllerOptions["cloudflare"]>> {
  try {
    return await importBrowserOptionalPeer<NonNullable<PlaywrightControllerOptions["cloudflare"]>>("@cloudflare/playwright")
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
        : await (options.chromium || await loadChromium()).connectOverCDP(connection.endpoint, {
            ...(connection.headers ? { headers: connection.headers } : {}),
          })
      return await attachPlaywrightBrowser(browser, connection)
    },
  }
}

export type { PlaywrightBrowserConnection } from "../internal/connections.ts"
