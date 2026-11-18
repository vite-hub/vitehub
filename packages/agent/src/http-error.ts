import {
  getViteHubErrorShape,
} from "@vite-hub/runtime"
import { agentDiagnostics } from "./agent-diagnostics.ts"
import {
  chatgptGatewayDiagnostic,
  readAgentErrorProperty,
  toAgentPublicError,
} from "./agent-error.ts"

const httpErrorsKey = Symbol.for("vitehub.agent.http-errors")

function httpErrors(): WeakSet<object> {
  // SAFETY: Agent HTTP error constructors own this shared slot in each bundle.
  const scope = globalThis as typeof globalThis & { [httpErrorsKey]?: WeakSet<object> }
  return scope[httpErrorsKey] ??= new WeakSet<object>()
}

/** An `AGENT_R0891` error whose status and message the Agent HTTP routes answer with as they are. */
export type AgentHttpError = ReturnType<typeof agentHttpError>

export function agentHttpError(statusCode: number, message: string) {
  const error = Object.assign(agentDiagnostics.AGENT_R0891({ message }), { status: statusCode, statusCode })
  httpErrors().add(error)
  return error
}

function getHttpErrorStatusCode(error: unknown): number | undefined {
  const statusCode = readAgentErrorProperty(error, "statusCode")
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode <= 599) return statusCode
  if (chatgptGatewayDiagnostic(error)) return readAgentErrorProperty(error, "code") === "AGENT_R1017" ? 429 : 503
  const code = getViteHubErrorShape(error)?.code
  if (code === "AUTHENTICATION_REQUIRED") return 401
  if (code === "RATE_LIMIT_REJECTED") return 429
  if (code === "RATE_LIMIT_UNAVAILABLE") return 503
  if (code === "CAPABILITY_DENIED") return 403
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
