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
  if (!isRuntimeRecord(value)) return
  if (Array.isArray(value)) {
    const values: AgentInspectionValue[] = []
    for (const item of value) {
      const inspected = inspectionValue(item)
      if (inspected === undefined) return
      values.push(inspected)
    }
    return values
  }
  const record: Record<string, AgentInspectionValue> = {}
  for (const [key, child] of Object.entries(value)) {
    const inspected = inspectionValue(child)
    if (inspected === undefined) return
    record[key] = inspected
  }
  return record
}

function standardJsonSchema(value: Record<string, unknown>, direction: "input" | "output"): AgentInspectionValue | undefined {
  const standard = value["~standard"]
  if (!isRuntimeRecord(standard)) return
  const jsonSchema = Reflect.get(standard, "jsonSchema")
  if (!jsonSchema || !hasRuntimeType(jsonSchema, "object")) return
  const resolve = Reflect.get(jsonSchema, direction)
  if (!hasRuntimeType(resolve, "function")) return
  try {
    return inspectionValue(resolve({ target: "draft-07" }))
  }
  catch {
    return
  }
}

function toolJsonSchema(value: unknown, direction: "input" | "output"): AgentInspectionValue | undefined {
  if (!isRuntimeRecord(value)) return
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
      const description = hasRuntimeType(tool.description, "string")
        ? tool.description
        : ""
      const inputSchema = toolJsonSchema(tool.inputSchema, "input")
        ?? (!providerDefined ? emptyToolInputSchema : undefined)
      const outputSchema = toolJsonSchema(tool.outputSchema, "output")
      return {
        ...(description ? { description } : {}),
        ...(inputSchema ? { inputSchema } : {}),
        name: key,
        ...(outputSchema ? { outputSchema } : {}),
      }
    })
  return inspected.length ? inspected : undefined
}
