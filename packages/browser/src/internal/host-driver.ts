import { browserErrorDiagnostics } from "../error-diagnostics.ts"
import { cdpBrowser } from "../providers/cdp.ts"
import { localBrowser } from "../providers/local.ts"

import type { BrowserDriver } from "../types.ts"
import type { CDPBrowserConnection } from "./connections.ts"

/**
 * The driver of Browser Definitions on a Node.js host. `BROWSER_CDP_URL` connects to a remote Chromium. Without it,
 * `local` starts a Chromium on this server, and `cdp` fails with the fix. `BROWSER_SANDBOX=false` runs the local
 * Chromium without its sandbox.
 */
export function hostBrowserDriver(
  driver: "cdp" | "local",
  env: Record<string, string | undefined> = process.env,
): BrowserDriver<CDPBrowserConnection> {
  const url = env.BROWSER_CDP_URL?.trim()
  if (url) return cdpBrowser({ url })
  if (driver === "cdp") {
    throw browserErrorDiagnostics.BROWSER_CDP_URL_REQUIRED()
  }
  const sandbox = env.BROWSER_SANDBOX?.trim().toLowerCase()
  return localBrowser({ sandbox: sandbox !== "false" && sandbox !== "0" })
}
