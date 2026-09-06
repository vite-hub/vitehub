import { browserProviderError } from "../errors.ts"
import { createCloudflareBrowser } from "../internal/cloudflare-provider.ts"

import type {
  CloudflareBrowserBindingConnection,
  CloudflareBrowserOptions,
  CloudflarePlaywrightDriver,
} from "../internal/cloudflare-provider.ts"
import type { BrowserProvider } from "../types.ts"

async function loadDriver(): Promise<CloudflarePlaywrightDriver> {
  try {
    return await import("@cloudflare/playwright") as unknown as CloudflarePlaywrightDriver
  }
  catch (error) {
    throw browserProviderError("cloudflare", "load @cloudflare/playwright", { cause: error })
  }
}

export function cloudflareBrowser(
  options: CloudflareBrowserOptions = {},
): BrowserProvider<CloudflareBrowserBindingConnection> {
  return createCloudflareBrowser(options, loadDriver)
}

export type {
  CloudflareBrowserBindingConnection,
  CloudflareBrowserOptions,
  CloudflarePlaywrightDriver,
} from "../internal/cloudflare-provider.ts"
