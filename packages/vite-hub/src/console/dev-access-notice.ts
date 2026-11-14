import { consolePublicKeyPrefix } from "@vite-hub/internal/console-signature"
import { isViteHubLoopbackAddress } from "@vite-hub/internal/dev-peer"

import type { ConsoleAccessMode } from "./runtime/server/access.ts"

const guide = "https://vitehub.dev/docs/development/console"

/** A startup line of a development server. */
export interface ConsoleDevAccessNotice {
  level: "info" | "warn"
  message: string
}

/**
 * The startup line of a development server that takes Console calls without a signature: `local` or `open` access, or
 * `console: true` (`token`) while `env` has no `VITEHUB_CONSOLE_KEY_<NAME>`. The Console endpoint answers only requests
 * from this machine, such as `vitehub` commands, but a tunnel or a proxy on this machine connects from it too, so the
 * line says that sharing the dev server needs signed calls. A server that listens on more than loopback gets a warning.
 * Returns `undefined` for signed calls, and for a server that listens on no TCP address.
 */
export function consoleDevAccessNotice(mode: ConsoleAccessMode | undefined, address: { address: string, port?: number } | string | null | undefined, env: Readonly<Record<string, unknown>> = process.env): ConsoleDevAccessNotice | undefined {
  if (!mode || !address || typeof address === "string") return
  const keyless = mode === "token" && !Object.keys(env).some(name => name.startsWith(consolePublicKeyPrefix) && String(env[name] ?? "").trim())
  if (mode === "token" && !keyless) return
  // Only a key makes a dev server take signed calls alone, so every fix ends with one.
  const key = `${consolePublicKeyPrefix}<NAME> variable`
  const fix = keyless ? `Set a ${key}` : mode === "open" ? `Remove console.auth and set a ${key}` : `Set console: true and a ${key}`
  if (isViteHubLoopbackAddress(address.address)) {
    return { level: "info", message: `[vitehub] The Console endpoint takes calls without a signature and answers only this machine. ${fix} before you share this dev server through a tunnel or a proxy: ${guide}` }
  }
  return { level: "warn", message: `[vitehub] The dev server listens on ${address.address}, and the Console endpoint takes calls without a signature. It refuses other machines, but a tunnel or a proxy on this machine can reach it. ${fix} before you share this dev server: ${guide}` }
}
