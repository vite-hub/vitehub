import {
  formatRuntimeDiagnosticError,
  getViteHubErrorShape,
} from "@vite-hub/runtime"

import { hasRuntimeType, isRuntimeObject } from "./internal/runtime-type.ts"

interface NormalizedAgentError {
  message: string
  name?: string
}

export function readAgentErrorProperty(error: unknown, key: PropertyKey): unknown {
  if (!hasRuntimeType(error, "object") || error === null) return
  try {
    return Reflect.get(error, key)
  }
  catch {
    return undefined
  }
}

export function isError(error: unknown): error is Error {
  if (!hasRuntimeType(error, "object") || error === null) return false
  try {
    return error instanceof Error
  }
  catch {
    return false
  }
}

function stringifyErrorValue(value: unknown): string | undefined {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(value, (_key, item) => {
      if (hasRuntimeType(item, "bigint")) return `${item}n`
      if (hasRuntimeType(item, "function")) return `[Function${item.name ? `: ${item.name}` : ""}]`
      if (hasRuntimeType(item, "symbol")) return String(item)
      if (isRuntimeObject(item)) {
        if (seen.has(item)) return "[Circular]"
        seen.add(item)
      }
      return item
    })
  }
  catch {
    return undefined
  }
}

export function formatAgentError(error: unknown, fallback = "Unknown error."): string {
  if (hasRuntimeType(readAgentErrorProperty(error, "code"), "string")
    || hasRuntimeType(readAgentErrorProperty(error, "why"), "string")) {
    return formatRuntimeDiagnosticError(error)
  }
  if (error instanceof Error) return error.stack || error.message || error.name || fallback
  if (hasRuntimeType(error, "string")) return error || fallback
  const text = stringifyErrorValue(error)
  if (text) return text
  if (error === undefined) return fallback
  try {
    const fallbackText = String(error)
    return fallbackText && fallbackText !== "[object Object]" ? fallbackText : fallback
  }
  catch {
    return fallback
  }
}

export function agentErrorDetails(error: unknown, fallback = "Unknown error."): NormalizedAgentError {
  if (hasRuntimeType(error, "string")) return { message: error || fallback }
  if (hasRuntimeType(error, "object") && error !== null) {
    const message = readAgentErrorProperty(error, "message")
    const name = readAgentErrorProperty(error, "name")
    if (hasRuntimeType(message, "string") && message) {
      return {
        message,
        ...(hasRuntimeType(name, "string") && name ? { name } : {}),
      }
    }
    if (isError(error) && hasRuntimeType(name, "string") && name) {
      return {
        message: name,
        name,
      }
    }
    return {
      message: fallback,
    }
  }
  if (error === undefined || error === null) return { message: fallback }
  try {
    return { message: String(error) || fallback }
  }
  catch {
    return { message: fallback }
  }
}

export function agentErrorMessage(error: unknown, fallback?: string): string {
  return agentErrorDetails(error, fallback).message
}

export type AgentPublicErrorCode =
  | "APPROVAL_REQUIRED"
  | "AUTHENTICATION_REQUIRED"
  | "CAPABILITY_DENIED"
  | "CAPABILITY_NOT_FOUND"
  | "INTERNAL"
  | "LLM_GATE_REJECTED"
  | "PROVIDER_AUTHENTICATION_FAILED"
  | "PROVIDER_QUOTA_EXHAUSTED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "RATE_LIMIT_REJECTED"
  | "RATE_LIMIT_UNAVAILABLE"
  | "TRANSCRIPTION_AUTHENTICATION_FAILED"
  | "TRANSCRIPTION_INVALID_PAYLOAD"
  | "TRANSCRIPTION_INVALID_REQUEST"
  | "TRANSCRIPTION_NETWORK_FAILED"
  | "TRANSCRIPTION_PROVIDER_FAILED"
  | "TRANSCRIPTION_QUOTA_EXCEEDED"
  | "TRANSCRIPTION_RATE_LIMITED"

export interface AgentPublicErrorDetails {
  capability?: string
  category?: string
  /** Provider quota reset time as an ISO 8601 timestamp, for a validated reset time. */
  resetAt?: string
  /** Validated provider quota reset time as the provider wrote it, for example `Sep 15th, 2026 1:23 AM`. */
  resetText?: string
  retryAfter?: number
}

export interface AgentPublicError {
  code: AgentPublicErrorCode
  details?: AgentPublicErrorDetails
  error: string
  requestId?: string
}

export type AgentPublicErrorContext = "http" | "invocation" | "serialization"

function identifier(value: unknown): string | undefined {
  if (!hasRuntimeType(value, "string") || value.length === 0 || value.length > 128) return
  return /^[A-Za-z0-9@][A-Za-z0-9@._:/-]*$/.test(value) ? value : undefined
}

function publicDetails(error: unknown, extra: AgentPublicErrorDetails = {}): AgentPublicErrorDetails | undefined {
  const owned = readAgentErrorProperty(error, "details")
  const capability = identifier(readAgentErrorProperty(error, "capabilityId"))
    ?? identifier(readAgentErrorProperty(owned, "capabilityId"))
    ?? identifier(readAgentErrorProperty(owned, "capability"))
  const details = { ...(capability ? { capability } : {}), ...extra }
  return Object.keys(details).length ? details : undefined
}

function publicError(
  code: Exclude<AgentPublicErrorCode, "INTERNAL">,
  error: string,
  details?: AgentPublicErrorDetails,
): AgentPublicError {
  return { code, ...(details ? { details } : {}), error }
}

// Codex and similar providers report "... try again at Sep 15th, 2026 1:23 AM." in the failure text.
// A date without a zone is read in the server's local time zone, the same clock the provider process used.
function quotaResetDetails(message: unknown): AgentPublicErrorDetails | undefined {
  if (!hasRuntimeType(message, "string")) return
  const afterPrompt = message.match(/try again at\s+(.+)/i)?.[1]
  if (!afterPrompt) return

  // Match timestamps first to keep periods in abbreviations and explicit zones.
  const timestamp = afterPrompt.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*|\s+)\d{4}\s+\d{1,2}:\d{2}\s+[ap]\.?m\.?(?:\s+(?:UTC|GMT|UT|[ECMP][DS]T|CET|CEST|EET|EEST|BST|IST|JST|AEST|AEDT|[+-]\d{2}:?\d{2}))?)(?=\.(?!\d)|\s*$)/i)?.[1]
  const resetText = timestamp?.replace(/\.$/, "")
  if (!resetText || resetText.length > 64) return
  const isoDate = resetText.match(/^(\d{4})-(\d{2})-(\d{2})T/i)
  const namedDate = resetText.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*|\s+)(\d{4})/i)
  const year = Number(isoDate?.[1] ?? namedDate?.[3])
  const month = isoDate
    ? Number(isoDate[2]) - 1
    : ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(namedDate?.[1]?.slice(0, 3).toLowerCase() ?? "")
  const day = Number(isoDate?.[3] ?? namedDate?.[2])
  // Date.parse applies legacy 1900-based conversion to named years below 100.
  // Reject them rather than publishing an instant for a different calendar year.
  if (namedDate && year < 100) return
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month]
  // Date.parse normalizes overflow days, so validate the provider's calendar date first.
  if (daysInMonth === undefined || day < 1 || day > daysInMonth) return
  const namedTime = namedDate && resetText.match(/\s(\d{1,2}):(\d{2})\s+([ap])\.?m\.?(?:\s+(.+))?$/i)
  // Date.parse can normalize invalid clock fields in named dates too.
  if (namedTime && (Number(namedTime[1]) < 1 || Number(namedTime[1]) > 12 || Number(namedTime[2]) > 59)) return
  const isoTime = isoDate && resetText.match(/T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?/i)
  // Date.parse can normalize invalid ISO clock fields too.
  if (isoTime && (Number(isoTime[1]) > 23 || Number(isoTime[2]) > 59 || Number(isoTime[3] ?? 0) > 59)) return
  // `resetAt` is serialized with millisecond precision. Reject finer input so
  // the public text and instant cannot describe different times.
  if (isoTime?.[4] && isoTime[4].length > 3) return
  const offset = resetText.match(/[+-](\d{2}):?(\d{2})$/)
  if (offset && (Number(offset[1]) > 14 || Number(offset[2]) > 59 || Number(offset[1]) === 14 && Number(offset[2]) !== 0)) return
  const namedZone = resetText.match(/\s(UTC|GMT|UT|[ECMP][DS]T|CET|CEST|EET|EEST|BST|IST|JST|AEST|AEDT)$/i)?.[1]
  // These abbreviations identify different offsets in different regions.
  // Without provider locale context, no single reset instant is safe to publish.
  if (namedZone && /^(?:BST|IST|CST|CDT|EST|EDT|MST|PST)$/i.test(namedZone)) return
  const namedZoneOffsets: Record<string, string> = {
    aest: "+10:00",
    aedt: "+11:00",
    cest: "+02:00",
    cet: "+01:00",
    eest: "+03:00",
    eet: "+02:00",
    gmt: "+00:00",
    jst: "+09:00",
    mdt: "-06:00",
    pdt: "-07:00",
    utc: "+00:00",
    ut: "+00:00",
  }
  const parseText = namedZone
    ? resetText.replace(new RegExp(`\\s${namedZone}$`, "i"), ` ${namedZoneOffsets[namedZone.toLowerCase()]}`)
    : resetText
  const time = Date.parse(parseText
    .replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/gi, "$1")
    .replace(/\b([ap])\.m\.?/gi, "$1m"))
  if (!Number.isFinite(time)) return
  // Date.parse normalizes nonexistent local wall times during DST transitions.
  // Do not publish a reset instant that differs from the provider's unzoned clock.
  if (namedTime && !namedTime[4] && !namedZone || isoTime && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(resetText)) {
    const parsed = new Date(time)
    const hour = namedTime
      ? Number(namedTime[1]) % 12 + (namedTime[3]?.toLowerCase() === "p" ? 12 : 0)
      : Number(isoTime?.[1])
    const minute = Number(namedTime?.[2] ?? isoTime?.[2])
    const second = Number(isoTime?.[3] ?? 0)
    const millisecond = Number((isoTime?.[4] ?? "").slice(0, 3).padEnd(3, "0"))
    if (parsed.getFullYear() !== year
      || parsed.getMonth() !== month
      || parsed.getDate() !== day
      || parsed.getHours() !== hour
      || parsed.getMinutes() !== minute
      || parsed.getSeconds() !== second
      || parsed.getMilliseconds() !== millisecond) return
    // During a DST fall-back transition, the same local wall time occurs twice.
    // Date.parse chooses one occurrence, but an unzoned provider timestamp does
    // not identify which instant it means, so omit the reset details.
    const localPartsMatch = (candidate: Date) => candidate.getFullYear() === year
      && candidate.getMonth() === month
      && candidate.getDate() === day
      && candidate.getHours() === hour
      && candidate.getMinutes() === minute
      && candidate.getSeconds() === second
      && candidate.getMilliseconds() === millisecond
    const offset = parsed.getTimezoneOffset()
    for (const sampleDays of [-2, -1, 1, 2]) {
      const sampledOffset = new Date(time + sampleDays * 24 * 60 * 60 * 1000).getTimezoneOffset()
      const alternateDelta = (sampledOffset - offset) * 60 * 1000
      if (alternateDelta !== 0 && localPartsMatch(new Date(time + alternateDelta))) return
    }
  }
  return { resetText, resetAt: new Date(time).toISOString() }
}

function quotaExhausted(...messages: unknown[]): AgentPublicError {
  const details = messages.map(quotaResetDetails).find(Boolean)
  return publicError("PROVIDER_QUOTA_EXHAUSTED", "AI provider quota is exhausted.", details)
}

function aiSdkProviderPublicError(error: unknown): AgentPublicError | undefined {
  const retry = readAgentErrorProperty(error, "name") === "AI_RetryError"
    ? readAgentErrorProperty(error, "lastError")
    : error
  const name = readAgentErrorProperty(retry, "name")
  if (name === "AI_LoadAPIKeyError") {
    return publicError("PROVIDER_AUTHENTICATION_FAILED", "AI provider credentials were rejected.")
  }
  if (name !== "AI_APICallError") return

  const status = readAgentErrorProperty(retry, "statusCode")
  const data = readAgentErrorProperty(retry, "data")
  const nested = readAgentErrorProperty(data, "error")
  const code = [
    readAgentErrorProperty(nested, "code"),
    readAgentErrorProperty(nested, "type"),
    readAgentErrorProperty(data, "code"),
  ].find(value => hasRuntimeType(value, "string"))
  const quota = hasRuntimeType(code, "string") && [
    "credit_balance_exhausted",
    "insufficient_quota",
    "organization_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "project_spend_limit_exceeded",
  ].includes(code)

  if (status === 401 || status === 403 && !quota) {
    return publicError("PROVIDER_AUTHENTICATION_FAILED", "AI provider credentials were rejected.")
  }
  if (status === 402 || quota) {
    return quotaExhausted(readAgentErrorProperty(nested, "message"), readAgentErrorProperty(retry, "message"))
  }
  if (status === 429) {
    return publicError("PROVIDER_RATE_LIMITED", "AI provider is temporarily rate limited. Try again later.")
  }
  if (hasRuntimeType(status, "number") && status >= 500) {
    return publicError("PROVIDER_UNAVAILABLE", "AI provider is temporarily unavailable. Try again later.")
  }
}

export function toAgentPublicError(error: unknown, context: AgentPublicErrorContext): AgentPublicError {
  try {
    const providerError = aiSdkProviderPublicError(error)
    if (providerError) return providerError
    // Only provider runtime diagnostics may opt into text-based quota classification.
    // Other internal failures can mention quotas without being provider failures.
    if (readAgentErrorProperty(error, "code") === "AGENT_R0726") {
      const message = readAgentErrorProperty(error, "message")
      if (hasRuntimeType(message, "string")
        && /usage limit|quota (?:is )?(?:exhausted|exceeded)|insufficient (?:quota|credits)|credit balance.*(?:low|exhausted)|spend(?:ing)? limit|spend.?cap|(?:billing|spending) budget (?:is )?exceeded/i.test(message)) {
        return quotaExhausted(message)
      }
    }
    const viteHubError = getViteHubErrorShape(error)
    if (viteHubError?.code === "AUTHENTICATION_REQUIRED") {
      return publicError("AUTHENTICATION_REQUIRED", "Authentication required.")
    }
    if (viteHubError?.code === "RATE_LIMIT_REJECTED" || viteHubError?.code === "RATE_LIMIT_UNAVAILABLE") {
      const retryAfter = viteHubError.details?.retryAfter
      const details = publicDetails(error, hasRuntimeType(retryAfter, "number") && Number.isFinite(retryAfter) && retryAfter >= 0
        ? { retryAfter }
        : {})
      return viteHubError.code === "RATE_LIMIT_UNAVAILABLE"
        ? publicError("RATE_LIMIT_UNAVAILABLE", "Rate limiting is unavailable.", details)
        : publicError("RATE_LIMIT_REJECTED", "Rate limit exceeded. Try again later.", details)
    }
    if (viteHubError?.code === "LLM_GATE_REJECTED") {
      const category = identifier(viteHubError.details?.category)
      return publicError("LLM_GATE_REJECTED", "Agent request was rejected.", publicDetails(error, category ? { category } : {}))
    }
    if (viteHubError?.code === "CAPABILITY_NOT_FOUND") {
      return publicError("CAPABILITY_NOT_FOUND", "Capability was not found.", publicDetails(error))
    }
    if (viteHubError?.code === "CAPABILITY_DENIED") {
      return publicError("CAPABILITY_DENIED", "Capability access was denied.", publicDetails(error))
    }
    if (viteHubError?.code === "APPROVAL_REQUIRED") {
      const requestId = identifier(readAgentErrorProperty(error, "requestId"))
      return {
        ...publicError("APPROVAL_REQUIRED", "Capability approval is required.", publicDetails(error)),
        ...(requestId ? { requestId } : {}),
      }
    }
    if (viteHubError?.code === "PROVIDER_LAUNCH_FAILED") {
      const requestId = identifier(viteHubError.requestId)
      return {
        ...publicError("PROVIDER_UNAVAILABLE", "I couldn't start the agent runtime. Please try again."),
        ...(requestId ? { requestId } : {}),
      }
    }
    if (viteHubError?.code === "TRANSCRIPTION_AUTHENTICATION_FAILED") {
      return publicError(viteHubError.code, "Audio transcription is unavailable because its provider credentials were rejected.")
    }
    if (viteHubError?.code === "TRANSCRIPTION_QUOTA_EXCEEDED") {
      return publicError(viteHubError.code, "Audio transcription is unavailable because its provider quota is exhausted.")
    }
    if (viteHubError?.code === "TRANSCRIPTION_RATE_LIMITED") {
      return publicError(viteHubError.code, "Audio transcription is temporarily rate limited. Try again later.")
    }
    if (viteHubError?.code === "TRANSCRIPTION_INVALID_REQUEST") {
      return publicError(viteHubError.code, "The audio could not be transcribed because the provider rejected it.")
    }
    if (viteHubError?.code === "TRANSCRIPTION_INVALID_PAYLOAD") {
      return publicError(viteHubError.code, "Audio transcription failed because the provider returned an invalid response.")
    }
    if (viteHubError?.code === "TRANSCRIPTION_NETWORK_FAILED") {
      return publicError(viteHubError.code, "Audio transcription is temporarily unavailable because the provider could not be reached.")
    }
    if (viteHubError?.code === "TRANSCRIPTION_PROVIDER_FAILED") {
      return publicError(viteHubError.code, "Audio transcription is temporarily unavailable. Try again later.")
    }
  }
  catch {}
  const fallback = context === "http"
    ? "Agent request failed."
    : context === "invocation"
      ? "Agent Invocation Stream failed."
      : "Agent Invocation Stream event could not be serialized."
  return { code: "INTERNAL", error: fallback }
}
