export function workflowBytesToBase64(data: Uint8Array): string {
  let binary = ""
  for (let offset = 0; offset < data.length; offset += 0x8000) {
    binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

const omittedWorkflowValue = Symbol("vitehub.agent.omitted-workflow-value")

export function cloneWorkflowJsonValue(value: unknown): unknown {
  const seen = new WeakSet<object>()
  const clone = (input: unknown, objectProperty = false): unknown | typeof omittedWorkflowValue => {
    if (input === undefined && objectProperty) return omittedWorkflowValue
    if (input === null || typeof input === "string" || typeof input === "boolean") return input
    if (typeof input === "number" && Number.isFinite(input) && !Object.is(input, -0)) return input
    if (!input || typeof input !== "object" || seen.has(input)) throw new TypeError("Agent Workflow inputs must contain only JSON-compatible values.")
    seen.add(input)
    try {
      if (Reflect.ownKeys(input).some(key => typeof key === "symbol")) throw new TypeError("Agent Workflow inputs must contain only JSON-compatible values.")
      if (Array.isArray(input)) {
        if (input.length !== Object.keys(input).length) throw new TypeError("Agent Workflow inputs must contain only JSON-compatible values.")
        return Array.from({ length: input.length }, (_, index) => {
          if (!Object.hasOwn(input, index)) throw new TypeError("Agent Workflow inputs must contain only JSON-compatible values.")
          const item = clone(input[index])
          if (item === omittedWorkflowValue) throw new TypeError("Agent Workflow inputs must contain only JSON-compatible values.")
          return item
        })
      }
      const prototype = Object.getPrototypeOf(input)
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Agent Workflow inputs must contain only JSON-compatible values.")
      const output: Record<string, unknown> = {}
      for (const key of Object.keys(input)) {
        const item = clone((input as Record<string, unknown>)[key], true)
        if (item !== omittedWorkflowValue) {
          Object.defineProperty(output, key, { configurable: true, enumerable: true, value: item, writable: true })
        }
      }
      return output
    }
    finally {
      seen.delete(input)
    }
  }
  const cloned = clone(value)
  if (cloned === omittedWorkflowValue) throw new TypeError("Agent Workflow inputs must contain only JSON-compatible values.")
  return cloned
}
