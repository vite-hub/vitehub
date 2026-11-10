import { isViteHubLoopbackAddress } from "@vite-hub/internal/dev-peer"
import { viteHubBasePath } from "@vite-hub/internal/runtime/page-tools-shared"
import { hostedConsoleUrl } from "@vite-hub/runtime"

import type { ConsoleAccessMode } from "./runtime/server/access.ts"

const guide = "https://vitehub.dev/docs/development/console"

/** A startup line of a development server. */
export interface ConsoleDevAccessNotice {
  level: "info" | "warn"
  message: string
}

/**
 * The startup line of a development server without Console sign-in (`local` or `open` access). It links the hosted
 * Console to this server, which accepts the Console's origin without a token in development. The Console answers only
 * requests from this machine, but a tunnel or a proxy on this machine connects from it too, so the line says that
 * sharing the dev server needs `console.auth`. A server that listens on more than loopback gets a warning.
 * Returns `undefined` for a Console with sign-in, and for a server that listens on no TCP address.
 */
export function consoleDevAccessNotice(mode: ConsoleAccessMode | undefined, address: { address: string, port?: number } | string | null | undefined, base?: string, browser: { url?: string, https?: boolean, host?: string } = {}): ConsoleDevAccessNotice | undefined {
  if ((mode !== "local" && mode !== "open") || !address || typeof address === "string") return
  // Use the host's browser URL when available. At Vite's listening event resolvedUrls is not ready yet,
  // so its configured host and TLS setting provide the same URL. HTTP IPv6 literals are outside the hosted CSP.
  const hostname = browser.host || (address.address === "127.0.0.1" ? "127.0.0.1" : "localhost")
  const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname
  let link = ""
  if (address.port) {
    try {
      const url = new URL(browser.url ?? `${browser.https ? "https" : "http"}://${host}:${address.port}`)
      if (["[::1]", "[::]", "0.0.0.0"].includes(url.hostname)) url.hostname = "localhost"
      url.pathname = viteHubBasePath(base)
      link = ` Open it in the Console: ${hostedConsoleUrl(url.href, "/")}`
    }
    catch {
      // The hosted Console opens only HTTPS apps and loopback HTTP servers.
    }
  }
  if (isViteHubLoopbackAddress(address.address)) {
    return { level: "info", message: `[vitehub] The Console endpoint has no sign-in and answers only this machine.${link} Set console.auth before you share this dev server through a tunnel or a proxy: ${guide}` }
  }
  return { level: "warn", message: `[vitehub] The dev server listens on ${address.address}, and the Console endpoint has no sign-in. It refuses other machines, but a tunnel or a proxy on this machine can reach it.${link} Set console.auth before you share this dev server: ${guide}` }
}
