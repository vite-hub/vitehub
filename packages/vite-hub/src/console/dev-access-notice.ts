import { isViteHubLoopbackAddress } from "@vite-hub/internal/dev-peer"

import type { ConsoleAccessMode } from "./runtime/server/access.ts"

const guide = "https://vitehub.dev/docs/development/console#share-a-development-server"

/** A startup line of a development server. */
export interface ConsoleDevAccessNotice {
  level: "info" | "warn"
  message: string
}

/**
 * The startup line about who can reach a development Console without sign-in (`local` or `open` access). The Console
 * answers only requests from this machine, but a tunnel or a proxy on this machine connects from it too, so the line
 * says that sharing the dev server needs `console.auth`. A server that listens on more than loopback gets a warning.
 * Returns `undefined` for a Console with sign-in, and for a server that listens on no TCP address.
 */
export function consoleDevAccessNotice(mode: ConsoleAccessMode | undefined, address: { address: string } | string | null | undefined): ConsoleDevAccessNotice | undefined {
  if ((mode !== "local" && mode !== "open") || !address || typeof address === "string") return
  if (isViteHubLoopbackAddress(address.address)) {
    return { level: "info", message: `[vitehub] The Console has no sign-in and answers only this machine. Set console.auth before you share this dev server through a tunnel or a proxy: ${guide}` }
  }
  return { level: "warn", message: `[vitehub] The dev server listens on ${address.address}, and the Console has no sign-in. The Console refuses other machines, but a tunnel or a proxy on this machine can reach it. Set console.auth before you share this dev server: ${guide}` }
}
