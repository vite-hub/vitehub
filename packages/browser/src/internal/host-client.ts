import runtimeConfig, { loadHostDriver } from "#vitehub/browser/runtime"

import { browserUnavailableError } from "../availability.ts"
import { createBrowser } from "../client.ts"

import type { BrowserClient } from "../types.ts"
import type { CDPBrowserConnection } from "./connections.ts"

let hostClient: BrowserClient<CDPBrowserConnection> | undefined

/**
 * The Browser Client of a build off Browser Run: a local or remote Chromium over CDP. It does not reference the
 * Cloudflare driver, so a quick action does not bundle Playwright.
 */
export async function resolveHostClient(): Promise<BrowserClient<CDPBrowserConnection>> {
  if (hostClient) return hostClient
  const driver = runtimeConfig.driver
  if ((driver !== "local" && driver !== "cdp") || !loadHostDriver) throw browserUnavailableError()
  const hostBrowserDriver = await loadHostDriver()
  hostClient = createBrowser({ driver: hostBrowserDriver(driver) })
  return hostClient
}

/** Whether this build runs quick actions on Browser Run. Other drivers read pages through a CDP session. */
export function usesBrowserRun(): boolean {
  return runtimeConfig.driver === "cloudflare"
}
