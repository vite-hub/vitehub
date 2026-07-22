import {
  getViteHubErrorShape,
} from "@vite-hub/runtime"

import {
  readAgentErrorProperty,
  toAgentPublicError,
} from "./agent-error.ts"

export class AgentHttpError extends Error {
  readonly status: number
  readonly statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = "AgentHttpError"
    this.status = statusCode
    this.statusCode = statusCode
  }
}

export function getHttpErrorStatusCode(error: unknown): number | undefined {
  const statusCode = readAgentErrorProperty(error, "statusCode")
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode <= 599) return statusCode
  const code = getViteHubErrorShape(error)?.code
  if (code === "AUTHENTICATION_REQUIRED") return 401
  if (code === "RATE_LIMIT_REJECTED") return 429
  if (code === "RATE_LIMIT_UNAVAILABLE") return 503
  if (code === "LLM_GATE_REJECTED" || code === "CAPABILITY_DENIED") return 403
  if (code === "CAPABILITY_NOT_FOUND") return 404
}

function isAgentHttpError(error: unknown): error is AgentHttpError {
  try {
    return error instanceof AgentHttpError
  }
  catch {
    return false
  }
}

export function getHttpErrorMessage(error: unknown): string {
  if (isAgentHttpError(error)) {
    const message = readAgentErrorProperty(error, "message")
    if (typeof message === "string") return message
  }
  return toAgentPublicError(error, "http").error
}

export function toHttpErrorResponse(error: unknown, fallbackStatus?: number): Response | undefined {
  const statusCode = getHttpErrorStatusCode(error) ?? fallbackStatus
  if (!statusCode) return
  if (isAgentHttpError(error)) return Response.json({ error: getHttpErrorMessage(error) }, { status: statusCode })
  const body = toAgentPublicError(error, "http")
  const retryAfter = body.details?.retryAfter
  return Response.json(body, {
    headers: retryAfter === undefined
      ? undefined
      : { "retry-after": String(retryAfter), "x-retry-after": String(retryAfter) },
    status: statusCode,
  })
}
