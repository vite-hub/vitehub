import { hasRuntimeType, isRuntimeRecord } from "./internal/runtime-type.ts"
import type { AgentInspectionValue, AgentToolInspection } from "./types.ts"

const emptyToolInputSchema = {
  additionalProperties: false,
  properties: {},
  type: "object",
} as const

function inspectionValue(value: unknown): AgentInspectionValue | undefined {
  if (value === null || hasRuntimeType(value, "boolean") || hasRuntimeType(value, "string")) return value
  if (hasRuntimeType(value, "number")) return Number.isFinite(value) ? value : undefined
  if (!value || !hasRuntimeType(value, "object")) return
  if (Array.isArray(value)) {
    const values: AgentInspectionValue[] = []
    for (const item of value) {
      const inspected = inspectionValue(item)
      if (inspected === undefined) return
      values.push(inspected)
    }
    return values
  }
  const inspected: Record<string, AgentInspectionValue> = {}
  for (const [key, child] of Object.entries(value)) {
    const inspectedChild = inspectionValue(child)
    if (inspectedChild === undefined) return
    inspected[key] = inspectedChild
  }
  return inspected
}

function standardJsonSchema(value: Record<string, unknown>, direction: "input" | "output"): AgentInspectionValue | undefined {
  const standard = value["~standard"]
  if (!isRuntimeRecord(standard)) return
  const jsonSchema = standard.jsonSchema
  if (!isRuntimeRecord(jsonSchema)) return
  const resolve = jsonSchema[direction]
  if (!hasRuntimeType(resolve, "function")) return
  try {
    return inspectionValue(resolve({ target: "draft-07" }))
  }
  catch {
    return
  }
}

function toolJsonSchema(value: unknown, direction: "input" | "output"): AgentInspectionValue | undefined {
  if (!value || !hasRuntimeType(value, "object")) return
  if ("~standard" in value) return standardJsonSchema(value, direction)
  if ("jsonSchema" in value) return inspectionValue(value.jsonSchema)
  return inspectionValue(value)
}

/** Return the serializable tool contract exposed to an Agent model. */
export function inspectAgentTools(tools: Record<string, unknown> | undefined): AgentToolInspection[] | undefined {
  if (!tools) return
  const inspected = Object.entries(tools)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => {
      const tool = isRuntimeRecord(value) ? value : {}
      const providerDefined = tool.type === "provider" || tool.type === "provider-defined"
      const inputSchema = toolJsonSchema(tool.inputSchema, "input")
        ?? (!providerDefined ? emptyToolInputSchema : undefined)
      const outputSchema = toolJsonSchema(tool.outputSchema, "output")
      return {
        ...(hasRuntimeType(tool.description, "string") ? { description: tool.description } : {}),
        ...(inputSchema ? { inputSchema } : {}),
        name: key,
        ...(outputSchema ? { outputSchema } : {}),
      }
    })
  return inspected.length ? inspected : undefined
}
