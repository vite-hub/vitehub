import { LlmGateRejectedError } from "./capabilities/llm-gate.ts"
import { RateLimitRejectedError } from "./capabilities/rate-limit.ts"
import { toAgentPublicError } from "./public-error.ts"

function readStatusCode(error: unknown): number | undefined {
  try {
    if (error instanceof RateLimitRejectedError) return 429
    if (error instanceof LlmGateRejectedError) return 403
  }
  catch {
    return
  }
  if (typeof error !== "object" || error === null) return
  let statusCode: unknown
  try {
    statusCode = (error as { statusCode?: unknown }).statusCode
  }
  catch {
    return
  }
  return typeof statusCode === "number" && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : undefined
}

export function getHttpErrorStatusCode(error: unknown): number | undefined {
  return readStatusCode(error)
}

export function getHttpErrorMessage(error: unknown): string {
  return toAgentPublicError(error, "http").error
}

function rateLimitHeaders(error: unknown): Record<string, string> | undefined {
  try {
    if (!(error instanceof RateLimitRejectedError)) return
  }
  catch {
    return
  }
  let value: unknown
  try {
    value = error.retryAfter
  }
  catch {
    return
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return
  return {
    "retry-after": String(value),
    "x-retry-after": String(value),
  }
}

export function toHttpErrorResponse(error: unknown, fallbackStatus?: number): Response | undefined {
  const statusCode = getHttpErrorStatusCode(error) || fallbackStatus
  if (!statusCode) return
  return Response.json(toAgentPublicError(error, "http"), {
    headers: rateLimitHeaders(error),
    status: statusCode,
  })
}
