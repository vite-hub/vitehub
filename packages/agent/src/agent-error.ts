import {
  getViteHubErrorShape,
} from "@vite-hub/runtime"

interface NormalizedAgentError {
  message: string
  name?: string
}

export function readAgentErrorProperty(error: unknown, key: PropertyKey): unknown {
  if (typeof error !== "object" || error === null) return
  try {
    return Reflect.get(error, key)
  }
  catch {
    return undefined
  }
}

function isError(error: object): boolean {
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
      if (typeof item === "bigint") return `${item}n`
      if (typeof item === "function") return `[Function${item.name ? `: ${item.name}` : ""}]`
      if (typeof item === "symbol") return String(item)
      if (item && typeof item === "object") {
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
  if (error instanceof Error) return error.stack || error.message || error.name || fallback
  if (typeof error === "string") return error || fallback
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
  if (typeof error === "string") return { message: error || fallback }
  if (typeof error === "object" && error !== null) {
    const message = readAgentErrorProperty(error, "message")
    const name = readAgentErrorProperty(error, "name")
    if (typeof message === "string" && message) {
      return {
        message,
        ...(typeof name === "string" && name ? { name } : {}),
      }
    }
    if (isError(error) && typeof name === "string" && name) {
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
  return { message: String(error) || fallback }
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
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return
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

export function toAgentPublicError(error: unknown, context: AgentPublicErrorContext): AgentPublicError {
  try {
    const viteHubError = getViteHubErrorShape(error)
    if (viteHubError?.code === "AUTHENTICATION_REQUIRED") {
      return publicError("AUTHENTICATION_REQUIRED", "Authentication required.")
    }
    if (viteHubError?.code === "RATE_LIMIT_REJECTED" || viteHubError?.code === "RATE_LIMIT_UNAVAILABLE") {
      const retryAfter = viteHubError.details?.retryAfter
      const details = publicDetails(error, typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0
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
