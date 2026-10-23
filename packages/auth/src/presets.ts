import { authErrorDiagnostics } from "./error-diagnostics.ts"

/** A duration such as `"30m"`, `"12h"`, `"7d"`, or `"2w"`. */
export type AuthDuration = `${number}${"s" | "m" | "h" | "d" | "w"}`

export interface AuthStatelessPresetOptions {
  /**
   * How long a session lasts after sign-in, in seconds or as a duration such as `"7d"`.
   * The session cookie and the encrypted session data use the same age. Defaults to 7 days.
   */
  maxAge?: number | AuthDuration
}

/** Sessions in encrypted cookies, with no database. Create it with `stateless()`. */
export interface AuthStatelessPreset {
  readonly name: "stateless"
  /** Session lifetime in seconds. */
  readonly maxAge: number
}

/** An Auth preset for the `preset` option of `defineAuth()`. */
export type AuthPreset = AuthStatelessPreset

const durationUnits: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800 }
const defaultStatelessMaxAge = 7 * 86_400

function durationSeconds(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : undefined
  if (typeof value !== "string") return
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d|w)$/.exec(value.trim())
  if (!match) return
  const seconds = Math.round(Number(match[1]) * durationUnits[match[2]!]!)
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
