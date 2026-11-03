import { requestConsole } from "./request.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

/** The counter of one policy of a Rate Limit, as the Console shows it. */
export interface ConsoleRateLimitCounter {
  limit: number
  remaining: number
  /** End of the current window in epoch milliseconds. Absent when the key has no active counter. */
  resetAt?: number
  used: number
  window: string
}

/** The answer to one peek: the counters, or why there are none. */
export interface ConsoleRateLimitPeek {
  counters: ConsoleRateLimitCounter[]
  key: string
  name: string
  provider: string
  /** Why no counters exist. Set for `unused`, `unsupported`, and `unavailable`. */
  reason?: string
  scope?: string
  status: "known" | "unavailable" | "unsupported" | "unused"
}

/** The answer to one reset. `reset` means the next request starts a new window. */
export interface ConsoleRateLimitReset {
  key: string
  name: string
  provider: string
  reason?: string
  status: "reset" | "unavailable" | "unsupported"
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function invalid(): never {
  throw viteHubErrorDiagnostics.VITE_HUB_R0098({ message: "The Console returned an invalid Rate Limit result." })
}

function target(value: Record<string, unknown>): { key: string, name: string, provider: string } {
  const key = text(value.key)
  const name = text(value.name)
  const provider = text(value.provider)
  if (key === undefined || name === undefined || provider === undefined) return invalid()
  return { key, name, provider }
}

export function parseConsoleRateLimitPeek(value: unknown): ConsoleRateLimitPeek {
  const result = record(value)
  const status = text(result?.status)
  if (!result || (status !== "known" && status !== "unavailable" && status !== "unsupported" && status !== "unused")) return invalid()
  const counters: ConsoleRateLimitCounter[] = []
  if (status === "known") {
    if (!Array.isArray(result.counters)) return invalid()
    for (const entry of result.counters) {
      const counter = record(entry)
      const limit = finite(counter?.limit)
      const remaining = finite(counter?.remaining)
      const used = finite(counter?.used)
      const window = text(counter?.window)
      if (limit === undefined || remaining === undefined || used === undefined || window === undefined) return invalid()
      const resetAt = finite(counter?.resetAt)
      counters.push({ limit, remaining, ...(resetAt === undefined ? {} : { resetAt }), used, window })
    }
  }
  const reason = text(result.reason)
  const scope = text(result.scope)
  return { counters, ...target(result), ...(reason ? { reason } : {}), ...(scope ? { scope } : {}), status }
}

export function parseConsoleRateLimitReset(value: unknown): ConsoleRateLimitReset {
  const result = record(value)
  const status = text(result?.status)
  if (!result || (status !== "reset" && status !== "unavailable" && status !== "unsupported")) return invalid()
  const reason = text(result.reason)
  return { ...target(result), ...(reason ? { reason } : {}), status }
}

/** Reads the counter of one key without consuming a token. */
export async function peekConsoleRateLimit(base: string, name: string, key: string, signal?: AbortSignal): Promise<ConsoleRateLimitPeek> {
  return parseConsoleRateLimitPeek(await requestConsole(base, { body: { action: "peek", key, name }, method: "POST", signal }))
}

/** Deletes the counter of one key, where the provider supports it. */
export async function resetConsoleRateLimit(base: string, name: string, key: string): Promise<ConsoleRateLimitReset> {
  return parseConsoleRateLimitReset(await requestConsole(base, { body: { action: "reset", key, name }, method: "POST" }))
}
