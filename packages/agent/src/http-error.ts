import {
  getViteHubErrorShape,
} from "@vite-hub/runtime"
import { Diagnostic } from "nostics"

import {
  readAgentErrorProperty,
  toAgentPublicError,
} from "./agent-error.ts"

const httpErrorsKey = Symbol.for("vitehub.agent.http-errors")

function httpErrors(): WeakSet<object> {
  // SAFETY: Agent HTTP error constructors own this shared slot in each bundle.
  const scope = globalThis as typeof globalThis & { [httpErrorsKey]?: WeakSet<object> }
  return scope[httpErrorsKey] ??= new WeakSet<object>()
}

export class AgentHttpError extends Diagnostic {
  readonly status: number
  readonly statusCode: number

  constructor(statusCode: number, message: string) {
    super({ code: "AGENT_R0891", docs: "https://vitehub.dev/docs/reference/errors-diagnostics#agent-public-errors", why: message }, AgentHttpError)
    this.name = "AgentHttpError"
    this.status = statusCode
    this.statusCode = statusCode
    httpErrors().add(this)
  }
}

function getHttpErrorStatusCode(error: unknown): number | undefined {
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
    return typeof error === "object" && error !== null && httpErrors().has(error)
  }
  catch {
    return false
  }
}

function getHttpErrorMessage(error: unknown): string {
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
