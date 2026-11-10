import { isViteHubLoopbackPeer } from "@vite-hub/internal/dev-peer"

import { isConsoleDevelopmentBuild } from "./development.ts"

import type { ConsoleAccessMode } from "./access.ts"

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

function isLoopbackHost(host: string | null): boolean {
  if (!host) return false
  const name = (host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d+$/, "")).toLowerCase()
  return loopbackHosts.has(name) || name.endsWith(".localhost")
}

/**
 * Whether a development Console without sign-in may serve this request. `vite dev` with no sign-in (the `local` or
 * `open` access) trusts anyone who can reach it, so it serves only this machine: a tunnel or a LAN address with a
 * forwarded Host would give the whole app to a stranger. Production builds and other access modes always pass.
 */
export async function isConsoleLoopbackRequest(request: Request, context: { access: ConsoleAccessMode, remoteAddress?: string }): Promise<boolean> {
  if ((context.access !== "local" && context.access !== "open") || !isConsoleDevelopmentBuild()) return true
  const hostHeader = request.headers.get("host") ?? new URL(request.url).host
  const forwarded = request.headers.get("x-forwarded-host")
  return isLoopbackHost(hostHeader) && (!forwarded || isLoopbackHost(forwarded)) && await isViteHubLoopbackPeer(request, context.remoteAddress)
}
