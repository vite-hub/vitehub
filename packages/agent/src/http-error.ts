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
