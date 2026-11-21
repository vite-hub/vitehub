import { consolePublicKeyPrefix } from "@vite-hub/internal/console-signature"
import { isViteHubLoopbackAddress } from "@vite-hub/internal/dev-peer"

import type { ConsoleAccessMode } from "./runtime/server/access.ts"

const guide = "https://vitehub.dev/docs/console/development#share-a-development-server"

/**
 * The startup warning of a development server that takes Console calls without a signature and listens beyond loopback,
 * such as with `--host`: `local` or `open` access, or `console: true` (`token`) while `env` has no
 * `VITEHUB_CONSOLE_KEY_<NAME>`. The Console endpoint refuses other machines, but a tunnel or a proxy on this machine
 * connects from it, so the warning says that sharing the dev server needs signed calls. A server on loopback only, as a
 * plain `vite dev`, gets no line: the Console endpoint answers only this machine there.
 * Returns `undefined` for signed calls, for loopback, and for a server that listens on no TCP address.
 */
export function consoleDevAccessNotice(mode: ConsoleAccessMode | undefined, address: { address: string, port?: number } | string | null | undefined, env: Readonly<Record<string, unknown>> = process.env): string | undefined {
  if (!mode || !address || typeof address === "string" || isViteHubLoopbackAddress(address.address)) return
  const keyless = mode === "token" && !Object.keys(env).some(name => name.startsWith(consolePublicKeyPrefix) && String(env[name] ?? "").trim())
  if (mode === "token" && !keyless) return
  // Only a key makes a dev server take signed calls alone, so every fix ends with one.
  const key = `${consolePublicKeyPrefix}<NAME> variable`
  const fix = keyless ? `Set a ${key}` : mode === "open" ? `Remove console.auth and set a ${key}` : `Set console: true and a ${key}`
  return `[vitehub] The dev server listens on ${address.address}, and the Console endpoint takes calls without a signature. It refuses other machines, but a tunnel or a proxy on this machine can reach it. ${fix} before you share this dev server: ${guide}`
}
