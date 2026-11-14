import { isViteHubLoopbackAddress } from "@vite-hub/internal/dev-peer"

import type { ConsoleAccessMode } from "./runtime/server/access.ts"

const guide = "https://vitehub.dev/docs/console/development#share-a-development-server"

/** A startup line of a development server. */
export interface ConsoleDevAccessNotice {
  level: "info" | "warn"
  message: string
}

/**
 * The startup line of a development server that takes Console calls without a signature (`local` or `open` access).
 * The Console endpoint answers only requests from this machine, such as `vitehub` commands, but a tunnel or a proxy on
 * this machine connects from it too, so the line says that sharing the dev server needs signed calls. A server that
 * listens on more than loopback gets a warning. Returns `undefined` for signed calls, and for a server that listens on
 * no TCP address.
 */
export function consoleDevAccessNotice(mode: ConsoleAccessMode | undefined, address: { address: string, port?: number } | string | null | undefined): ConsoleDevAccessNotice | undefined {
  if ((mode !== "local" && mode !== "open") || !address || typeof address === "string") return
  if (isViteHubLoopbackAddress(address.address)) {
    return { level: "info", message: `[vitehub] The Console endpoint takes calls without a signature and answers only this machine. Remove console.auth before you share this dev server through a tunnel or a proxy: ${guide}` }
  }
  return { level: "warn", message: `[vitehub] The dev server listens on ${address.address}, and the Console endpoint takes calls without a signature. It refuses other machines, but a tunnel or a proxy on this machine can reach it. Remove console.auth before you share this dev server: ${guide}` }
}
