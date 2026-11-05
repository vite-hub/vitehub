import { consoleRequestError } from "./request.ts"
import { isConsoleDevelopmentBuild } from "./development.ts"

import type { ConsoleAccess } from "./access.ts"

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

function isLoopbackHost(host: string | null): boolean {
  if (!host) return false
  const name = (host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d+$/, "")).toLowerCase()
  return loopbackHosts.has(name) || name.endsWith(".localhost")
}

function isLoopbackAddress(address: string): boolean {
  return address === "::1" || address === "127.0.0.1" || address.startsWith("127.") || address.startsWith("::ffff:127.")
}

/**
 * `vite dev` with no sign-in (the `local` or `open` access) trusts anyone who can reach it, so it serves only this
 * machine: a tunnel or a LAN address with a forwarded Host would give the whole app to a stranger.
 */
export function assertLoopbackWithoutSignIn(request: Request, url: URL, context: { access: ConsoleAccess, remoteAddress?: string }): void {
  if ((context.access.mode !== "local" && context.access.mode !== "open") || !isConsoleDevelopmentBuild()) return
  const hostHeader = request.headers.get("host") ?? url.host
  const forwarded = request.headers.get("x-forwarded-host")
  if (isLoopbackHost(hostHeader) && (!forwarded || isLoopbackHost(forwarded)) && (!context.remoteAddress || isLoopbackAddress(context.remoteAddress))) return
  throw consoleRequestError(403, "The development Console without sign-in accepts only requests from this machine. Set console.auth to open it to others.", "CONSOLE_LOOPBACK_ONLY")
}
