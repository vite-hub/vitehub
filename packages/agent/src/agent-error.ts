interface NormalizedAgentError {
  message: string
  name?: string
}

function errorProperty(error: object, key: "message" | "name"): unknown {
  try {
    return (error as Record<string, unknown>)[key]
  }
  catch {
    return undefined
  }
}

export function agentErrorDetails(error: unknown, fallback = "Unknown error."): NormalizedAgentError {
  if (typeof error === "string") return { message: error || fallback }
  if (typeof error === "object" && error !== null) {
    const message = errorProperty(error, "message")
    const name = errorProperty(error, "name")
    if (typeof message === "string" && message) {
      return {
        message,
        ...(typeof name === "string" && name ? { name } : {}),
      }
    }
    if (error instanceof Error && typeof name === "string" && name) {
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

export function agentErrorPublicMessage(error: unknown, fallback = "Agent request failed."): string {
  if (typeof error === "object" && error !== null) {
    const message = errorProperty(error, "message")
    if (typeof message === "string") return message || fallback
  }
  return fallback
}
