import { LlmGateRejectedError } from "./capabilities/llm-gate.ts"

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
  return error instanceof Error && error.message ? error.message : "Agent request failed."
}

export function toHttpErrorResponse(error: unknown): Response | undefined {
  const statusCode = getHttpErrorStatusCode(error)
  if (!statusCode) return
  return Response.json({ error: getHttpErrorMessage(error) }, { status: statusCode })
}
