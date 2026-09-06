import { browserProviderError } from "../errors.ts"

import type { BrowserType } from "playwright-core"

export async function loadChromium(): Promise<Pick<BrowserType, "connectOverCDP">> {
  try {
    return (await import("playwright-core")).chromium
  }
  catch (error) {
    throw browserProviderError("playwright", "load playwright-core", { cause: error })
  }
}
