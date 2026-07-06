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
    const message = errorProperty(error, "message")
    const name = errorProperty(error, "name")
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

export function agentErrorPublicMessage(error: unknown, fallback = "Agent request failed."): string {
  if (typeof error === "object" && error !== null) {
    const message = errorProperty(error, "message")
    if (typeof message === "string") return message || fallback
  }
  return fallback
}
