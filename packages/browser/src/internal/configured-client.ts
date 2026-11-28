import runtimeConfig, { loadCloudflarePlaywright } from "#vitehub/browser/runtime"

import { browserUnavailableError, isBrowserAvailable } from "../availability.ts"
import { createBrowser } from "../client.ts"
import { createCloudflareBrowser } from "./cloudflare-provider.ts"
import { resolveHostClient } from "./host-client.ts"
import { importBrowserOptionalPeer } from "./optional-peer.ts"

import type { BrowserClient } from "../types.ts"
import type { CloudflarePlaywrightDriver } from "./cloudflare-provider.ts"
import type { PlaywrightBrowserConnection } from "./connections.ts"

let cloudflareClient: BrowserClient<PlaywrightBrowserConnection> | undefined

/** The Browser Client of this build: Browser Run on Cloudflare, else a local or remote Chromium over CDP. */
export async function resolveConfiguredClient(): Promise<BrowserClient<PlaywrightBrowserConnection>> {
  if (!isBrowserAvailable()) throw browserUnavailableError()
  if (runtimeConfig.driver !== "cloudflare") return await resolveHostClient()
  const configuredLoader = loadCloudflarePlaywright
    ?? (() => importBrowserOptionalPeer<CloudflarePlaywrightDriver>("@cloudflare/playwright"))
  cloudflareClient ??= createBrowser({
    driver: createCloudflareBrowser({ binding: runtimeConfig.binding, engine: runtimeConfig.engine }, configuredLoader),
  })
  return cloudflareClient
}
