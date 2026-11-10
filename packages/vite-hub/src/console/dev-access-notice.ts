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
export function consoleDevAccessNotice(mode: ConsoleAccessMode | undefined, address: { address: string, port?: number } | string | null | undefined, base?: string): ConsoleDevAccessNotice | undefined {
  if ((mode !== "local" && mode !== "open") || !address || typeof address === "string") return
  // A server on one loopback address may refuse `localhost`, which can resolve to the other address family.
  const host = address.address === "127.0.0.1" ? "127.0.0.1" : address.address === "::1" ? "[::1]" : "localhost"
  const link = address.port ? ` Open it in the Console: ${hostedConsoleUrl(`http://${host}:${address.port}${viteHubBasePath(base)}`, "/")}` : ""
  if (isViteHubLoopbackAddress(address.address)) {
    return { level: "info", message: `[vitehub] The Console endpoint has no sign-in and answers only this machine.${link} Set console.auth before you share this dev server through a tunnel or a proxy: ${guide}` }
  }
  return { level: "warn", message: `[vitehub] The dev server listens on ${address.address}, and the Console endpoint has no sign-in. It refuses other machines, but a tunnel or a proxy on this machine can reach it.${link} Set console.auth before you share this dev server: ${guide}` }
}
