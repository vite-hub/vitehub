import { LlmGateRejectedError } from "./capabilities/llm-gate.ts"
import { agentErrorPublicMessage } from "./agent-error.ts"

function readStatusCode(error: unknown): number | undefined {
  if (error instanceof LlmGateRejectedError) return (error as unknown as { statusCode: number }).statusCode
  if (typeof error !== "object" || error === null) return
  const statusCode = (error as { statusCode?: unknown }).statusCode
  return typeof statusCode === "number" && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : undefined
}

export function getHttpErrorStatusCode(error: unknown): number | undefined {
  return readStatusCode(error)
}

export function getHttpErrorMessage(error: unknown): string {
  return agentErrorPublicMessage(error, "Agent request failed.")
}

function readHeaders(error: unknown): Headers | Record<string, string> | undefined {
  if (typeof error !== "object" || error === null) return
  const headers = (error as { headers?: unknown }).headers
  if (headers instanceof Headers) return headers
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return
  const entries = Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  return entries.length ? Object.fromEntries(entries) : undefined
}

export function toHttpErrorResponse(error: unknown): Response | undefined {
  const statusCode = getHttpErrorStatusCode(error)
  if (!statusCode) return
  return Response.json({ error: getHttpErrorMessage(error) }, {
    headers: readHeaders(error),
    status: statusCode,
  })
}
