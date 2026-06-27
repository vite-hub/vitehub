interface NormalizedAgentError {
  message: string
  name?: string
}

export function agentErrorDetails(error: unknown, fallback = "Unknown error."): NormalizedAgentError {
  if (error instanceof Error) {
    return {
      message: error.message || error.name || fallback,
      ...(error.name ? { name: error.name } : {}),
    }
  }
  if (typeof error === "string") return { message: error || fallback }
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message
    const name = (error as { name?: unknown }).name
    if (typeof message === "string" && message) {
      return {
        message,
        ...(typeof name === "string" && name ? { name } : {}),
      }
    }
    try {
      const json = JSON.stringify(error)
      if (json) return { message: json }
    }
    catch {}
  }
  if (error === undefined || error === null) return { message: fallback }
  return { message: String(error) || fallback }
}

export function agentErrorMessage(error: unknown, fallback?: string): string {
  return agentErrorDetails(error, fallback).message
}

export function agentErrorPublicMessage(error: unknown, fallback = "Agent request failed."): string {
  if (error instanceof Error) return error.message || fallback
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message || fallback
  }
  return fallback
}
