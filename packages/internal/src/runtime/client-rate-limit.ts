/** A fixed-window budget for each client address: `{ limit: 5, window: "1m" }`. */
export interface ClientRateLimitPolicy {
  limit: number
  /** A duration such as `30s`, `1m`, or `1h`. */
  window: string
}

export interface ClientRateLimitDecision {
  allowed: boolean
  /** Seconds until the client may try again. */
  retryAfter?: number
}

/** The part of `checkRateLimit()` from `vite-hub/rate-limit` that a public write calls. */
export type SharedRateLimit = (request: Request, name: string, options: { key: string, limit: number, window: `${number}${"ms" | "s" | "m" | "h" | "d"}` }) => Promise<[unknown, { allowed: boolean, reason?: string, retryAfter?: number, cause?: unknown } | undefined]>

/** What a client limit reads from the Standard Context of a request. */
export interface ClientRateLimitContext {
  runtime?: { clientAddress?: string, cloudflare?: object }
}

const windowPattern = /^(\d+)(ms|s|m|h|d)$/
const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** Why `policy` is not a budget, or `undefined` when it is one. */
export function clientRateLimitIssue(policy: ClientRateLimitPolicy): string | undefined {
  if (!Number.isInteger(policy.limit) || policy.limit < 1) return "`rateLimit.limit` must be a whole number of 1 or more."
  if (!windowPattern.test(policy.window)) return "`rateLimit.window` must be a duration such as `30s`, `1m`, or `1h`."
  const duration = windowMs(policy.window)
  if (!Number.isFinite(duration) || duration <= 0 || duration > 8.64e15) return "`rateLimit.window` must resolve to finite milliseconds greater than zero and at most 8640000000000000."
  return undefined
}

function windowMs(window: string): number {
  const [, amount, unit] = windowPattern.exec(window) ?? []
  return Number(amount) * (units[unit ?? "m"] ?? 60_000)
}

/** An IPv6 address counts as its /64 network, since one host can use any address in it. */
export function addressKey(address: string): string {
  if (!address.includes(":") || address.includes(".")) return address
  const [head = "", tail = ""] = address.toLowerCase().split("::")
  const left = head ? head.split(":") : []
  const right = tail ? tail.split(":") : []
  const groups = address.includes("::") ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => "0"), ...right] : left
  return `${groups.slice(0, 4).map(group => group.replace(/^0+(?=.)/, "")).join(":")}::/64`
}

/** The address that a client limit counts: the host's client address, else `cf-connecting-ip` on Cloudflare only. */
export function clientAddressKey(request: Request, context: ClientRateLimitContext | undefined): string {
  return addressKey(context?.runtime?.clientAddress ?? (context?.runtime?.cloudflare ? request.headers.get("cf-connecting-ip") : undefined) ?? "unknown")
}

/** A fixed window for each key, in this process only. Enough for one Node server; a Worker should use Rate Limit. */
export function memoryClientRateLimit(now: () => number = Date.now): (key: string, policy: ClientRateLimitPolicy) => ClientRateLimitDecision {
  const windows = new Map<string, { count: number, resetAt: number }>()
  let nextSweep = 0
  return (key, policy) => {
    const time = now()
    // At most one sweep a second, so many live keys do not make every request walk the map.
    if (windows.size > 10_000 && time >= nextSweep) {
      nextSweep = time + 1000
      for (const [stale, entry] of windows) if (entry.resetAt <= time) windows.delete(stale)
    }
    const current = windows.get(key)
    const entry = current && current.resetAt > time ? current : { count: 0, resetAt: time + windowMs(policy.window) }
    entry.count += 1
    windows.set(key, entry)
    return entry.count <= policy.limit ? { allowed: true } : { allowed: false, retryAfter: (entry.resetAt - time) / 1000 }
  }
}

export interface ClientRateLimitOptions {
  /** The Rate Limit name that `shared` counts under, such as `forms` or `comments`. */
  name: string
  /** `checkRateLimit` of ViteHub Rate Limit, when it counts in a KV store that every server process shares. */
  shared?: SharedRateLimit
  /** The error log when the shared store does not answer, such as `Forms could not count this message in Rate Limit`. */
  unavailable: string
  now?: () => number
}

/**
 * The rate limit of a public write, such as a form message or a guest comment. It counts `key` in the shared Rate
 * Limit store when the app has one, else in the memory of this process. When the shared store does not answer, it
 * logs the error and counts in memory.
 */
export function createClientRateLimit(options: ClientRateLimitOptions): (request: Request, key: string, policy: ClientRateLimitPolicy) => Promise<ClientRateLimitDecision> {
  const memory = memoryClientRateLimit(options.now)
  const { shared, name } = options
  return async (request, key, policy) => {
    if (shared) {
      // SAFETY: clientRateLimitIssue() accepts only windows such as `30s` or `1m`, and Rate Limit checks the window again.
      const window = policy.window as `${number}m`
      const [error, decision] = await shared(request, name, { key, limit: policy.limit, window })
      if (decision && decision.reason !== "unavailable") return decision.allowed || decision.retryAfter === undefined ? { allowed: decision.allowed } : { allowed: false, retryAfter: decision.retryAfter }
      console.error(`[vitehub] ${options.unavailable}, so it counts it in the memory of this process.`, error ?? decision?.cause)
    }
    return memory(key, policy)
  }
}
