import { isViteHubLoopbackAddress, readViteHubDevPeerKey, verifyViteHubDevPeer } from "@vite-hub/internal/dev-peer"

import { consoleRequestError } from "./request.ts"
import { isConsoleDevelopmentBuild } from "./development.ts"

import type { ConsoleAccess } from "./access.ts"

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

function isLoopbackHost(host: string | null): boolean {
  if (!host) return false
  const name = (host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d+$/, "")).toLowerCase()
  return loopbackHosts.has(name) || name.endsWith(".localhost")
}

/**
 * Whether the request came from this machine. Headers can be forged, so only the socket decides.
 * - A dev server whose front process signs loopback requests gives its worker a key. The worker then trusts only
 *   that evidence, because its own peer is the proxy of the front process.
 * - Without a key, the peer address that the host adapter reports decides. An unknown peer is refused.
 */
async function isLoopbackPeer(request: Request, remoteAddress: string | undefined): Promise<boolean> {
  if (remoteAddress && !isViteHubLoopbackAddress(remoteAddress)) return false
  const key = readViteHubDevPeerKey()
  return key ? verifyViteHubDevPeer(request, key) : isViteHubLoopbackAddress(remoteAddress)
}

/**
 * `vite dev` with no sign-in (the `local` or `open` access) trusts anyone who can reach it, so it serves only this
 * machine: a tunnel or a LAN address with a forwarded Host would give the whole app to a stranger.
 */
export async function assertLoopbackWithoutSignIn(request: Request, url: URL, context: { access: ConsoleAccess, remoteAddress?: string }): Promise<void> {
  if ((context.access.mode !== "local" && context.access.mode !== "open") || !isConsoleDevelopmentBuild()) return
  const hostHeader = request.headers.get("host") ?? url.host
  const forwarded = request.headers.get("x-forwarded-host")
  if (isLoopbackHost(hostHeader) && (!forwarded || isLoopbackHost(forwarded)) && await isLoopbackPeer(request, context.remoteAddress)) return
  throw consoleRequestError(403, "The development Console without sign-in accepts only requests from this machine. Set console.auth to open it to others.", "CONSOLE_LOOPBACK_ONLY")
}
