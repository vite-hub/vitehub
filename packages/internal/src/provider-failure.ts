/**
 * What a failed Cloudflare or Vercel API call means, in one closed set.
 *
 * - `not-found`: the resource does not exist.
 * - `conflict`: the resource already exists, or its current state rejects the change.
 * - `throttled`: a rate limit or quota stops the request for now.
 * - `unauthorized`: the credentials are missing, wrong, or lack permission.
 * - `invalid`: the request is wrong. Sending it again gives the same result.
 * - `unavailable`: the provider failed or timed out. A retry can succeed.
 */
export type ProviderFailureKind = "conflict" | "invalid" | "not-found" | "throttled" | "unauthorized" | "unavailable"

/** Cloudflare error codes are unique only inside one product, so the product selects the code table. */
export type CloudflareProduct = "d1" | "kv" | "queues" | "r2"

export type ProviderFailureSource =
  | { host: "cloudflare", product?: CloudflareProduct }
  | { host: "vercel" }

export interface ProviderFailureInput {
  /** Provider error codes: Cloudflare `errors[].code` or Vercel `error.code`. */
  codes?: readonly (number | string)[]
  /** HTTP status of the response. Workers bindings do not have one. */
  status?: number
}

// https://developers.cloudflare.com/r2/api/error-codes/
const r2Codes: Readonly<Record<number, ProviderFailureKind>> = {
  10001: "unavailable",
  10002: "unauthorized",
  10003: "unauthorized",
  // Not in the R2 table. The REST API returns it with 400 when the account already owns the bucket.
  10004: "conflict",
  10005: "invalid",
  10006: "not-found",
  10007: "not-found",
  10008: "conflict",
  10009: "invalid",
  10011: "invalid",
  10012: "invalid",
  10013: "invalid",
  10014: "invalid",
  10018: "unauthorized",
  10020: "invalid",
  10024: "not-found",
  10025: "invalid",
  10031: "conflict",
  10033: "invalid",
  10035: "unauthorized",
  10037: "invalid",
  10039: "invalid",
  10042: "unauthorized",
  10043: "unavailable",
  10048: "invalid",
  10054: "unavailable",
  10058: "throttled",
  10069: "conflict",
  10073: "conflict",
  100100: "invalid",
}

const kvCodes: Readonly<Record<number, ProviderFailureKind>> = {
  // "a namespace with this account ID and title already exists", returned with 400.
  // https://github.com/cloudflare/workers-sdk/issues/14284
  10014: "conflict",
}

// https://developers.cloudflare.com/queues/reference/error-codes/
const queuesCodes: Readonly<Record<number, ProviderFailureKind>> = {
  10104: "not-found",
  10106: "unauthorized",
  10107: "invalid",
  10201: "unavailable",
  10202: "invalid",
  10203: "invalid",
  10204: "invalid",
  10205: "invalid",
  10206: "invalid",
  10207: "invalid",
  10208: "invalid",
  10250: "throttled",
  10251: "throttled",
  10252: "throttled",
  10253: "throttled",
  15000: "unavailable",
}

// D1 does not document numeric REST error codes, so D1 failures use the HTTP status.
const cloudflareCodes: Readonly<Record<CloudflareProduct, Readonly<Record<number, ProviderFailureKind>>>> = {
  d1: {},
  kv: kvCodes,
  queues: queuesCodes,
  r2: r2Codes,
}

// https://vercel.com/docs/rest-api/errors
const vercelCodes: Readonly<Record<string, ProviderFailureKind>> = {
  bad_request: "invalid",
  conflict_aliases: "conflict",
  forbidden: "unauthorized",
  internal_server_error: "unavailable",
  method_unknown: "invalid",
  not_found: "not-found",
  // Vercel answers "already exists" for a domain with this code.
  not_modified: "conflict",
  rate_limited: "throttled",
  service_unavailable: "unavailable",
}

function kindFromStatus(status: number): ProviderFailureKind | undefined {
  if (status === 401 || status === 403) return "unauthorized"
  if (status === 404 || status === 410) return "not-found"
  if (status === 409 || status === 412) return "conflict"
  if (status === 429) return "throttled"
  if (status === 408 || status >= 500) return "unavailable"
  if (status >= 400) return "invalid"
}

/**
 * Classifies a failed provider call. A documented provider code wins over the HTTP status.
 * Returns `undefined` only when neither a known code nor an error status is present.
 */
export function classifyProviderFailure(source: ProviderFailureSource, { codes = [], status }: ProviderFailureInput): ProviderFailureKind | undefined {
  for (const code of codes) {
    const kind = source.host === "vercel"
      ? (typeof code === "string" && Object.hasOwn(vercelCodes, code) ? vercelCodes[code] : undefined)
      : (source.product && typeof code === "number" && Object.hasOwn(cloudflareCodes[source.product], code) ? cloudflareCodes[source.product][code] : undefined)
    if (kind) return kind
  }
  return status === undefined ? undefined : kindFromStatus(status)
}

/** Finds the Cloudflare product of an account API path, such as `/r2/buckets`. */
export function cloudflareProductOfPath(path: string): CloudflareProduct | undefined {
  if (path.startsWith("/r2/")) return "r2"
  if (path.startsWith("/storage/kv/")) return "kv"
  if (path.startsWith("/d1/")) return "d1"
  if (path === "/queues" || path.startsWith("/queues/") || path.startsWith("/queues?")) return "queues"
}

/**
 * Reads the error codes of a Cloudflare (`errors[].code`) or Vercel (`error.code`) error body.
 * Keeps only codes that are safe to print: numbers, and short strings without spaces or line breaks.
 */
export function readProviderErrorCodes(body: unknown): (number | string)[] {
  if (!body || typeof body !== "object") return []
  const error: unknown = Reflect.get(body, "error")
  const errors: unknown = Reflect.get(body, "errors")
  const candidates: unknown[] = [
    error && typeof error === "object" ? Reflect.get(error, "code") : undefined,
    ...(Array.isArray(errors) ? errors.map((entry: unknown) => entry && typeof entry === "object" ? Reflect.get(entry, "code") : undefined) : []),
  ]
  return candidates.filter((code): code is number | string => (typeof code === "number" && Number.isFinite(code))
    || (typeof code === "string" && /^[\w.-]{1,128}$/.test(code)))
}
