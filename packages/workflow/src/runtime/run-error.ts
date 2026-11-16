import type { WorkflowRunError } from "../types.ts"

function ownString(value: object, key: string): string | undefined {
  try {
    const member: unknown = Reflect.get(value, key)
    return typeof member === "string" && member ? member : undefined
  }
  catch {
    return undefined
  }
}

/**
 * Converts the failure that a provider stores to the JSON-safe `error` of a failed run. It keeps `message`, `code`,
 * and a `name` other than `Error`, and drops the stack. A failure without a message gets a generic message, so every
 * failed run has an `error`.
 */
export function toWorkflowRunError(value: unknown): WorkflowRunError {
  if (typeof value === "string" && value) return { message: value }
  if (typeof value === "object" && value !== null) {
    const message = ownString(value, "message")
    if (message !== undefined) {
      const code = ownString(value, "code")
      const name = ownString(value, "name")
      return { ...(code ? { code } : {}), message, ...(name && name !== "Error" ? { name } : {}) }
    }
  }
  return { message: "Workflow run failed." }
}
