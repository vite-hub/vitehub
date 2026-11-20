import { parseDuration } from "@vite-hub/runtime"

import { authErrorDiagnostics } from "./error-diagnostics.ts"

import type { Duration } from "@vite-hub/runtime"

export interface AuthStatelessPresetOptions {
  /**
   * How long a session lasts after sign-in, in seconds or as a duration such as `"7d"`.
   * The session cookie and the encrypted session data use the same age. Defaults to 7 days.
   */
  maxAge?: number | Duration
}

/** Sessions in encrypted cookies, with no database. Create it with `stateless()`. */
export interface AuthStatelessPreset {
  readonly name: "stateless"
  /** Session lifetime in seconds. */
  readonly maxAge: number
}

/** An Auth preset for the `preset` option of `defineAuth()`. */
export type AuthPreset = AuthStatelessPreset

const defaultStatelessMaxAge = 7 * 86_400

function durationSeconds(value: number | Duration): number | undefined {
  const seconds = typeof value === "string" ? Math.round(parseDuration(value, "maxAge") / 1000) : value
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined
}

/**
 * Keep sessions in encrypted cookies, with no database. Sessions survive restarts and work across
 * replicas and Workers when every instance uses the same secret. Use it with social providers.
 */
export function stateless(options: AuthStatelessPresetOptions = {}): AuthStatelessPreset {
  const maxAge = options.maxAge === undefined ? defaultStatelessMaxAge : durationSeconds(options.maxAge)
  if (maxAge === undefined) {
    throw authErrorDiagnostics.AUTH_C0049({ message: `\`stateless({ maxAge })\` must be a positive whole number of seconds or a duration such as "7d". Received ${JSON.stringify(options.maxAge)}.` })
  }
  return { name: "stateless", maxAge }
}
