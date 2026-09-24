import { hasRuntimeType, isRuntimeRecord } from "./internal/runtime-type.ts"
import { agentToolJsonSchema } from "./tool-schema.ts"
import type { AgentInspectionValue, AgentToolInspection } from "./types.ts"
import type { AgentToolSchema } from "./types.ts"

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
  try {
    // SAFETY: The Standard Schema discriminator is checked by toolJsonSchema before this helper is called.
    return inspectionValue(agentToolJsonSchema(value as AgentToolSchema, direction))
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

export function inspectMcpToolProvenance(value: unknown): AgentToolInspection["mcp"] {
  const tool = isRuntimeRecord(value) ? value : undefined
  const metadata = isRuntimeRecord(tool?.metadata) ? tool.metadata : undefined
  if (hasRuntimeType(metadata?.mcpServer, "string") && hasRuntimeType(metadata?.originalName, "string")) {
    return { server: metadata.mcpServer, name: metadata.originalName }
  }
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
        ?? (!providerDefined && tool.inputSchema === undefined ? emptyToolInputSchema : undefined)
      const outputSchema = toolJsonSchema(tool.outputSchema, "output")
      const mcp = inspectMcpToolProvenance(value)
      return {
        ...(description ? { description } : {}),
        ...(inputSchema ? { inputSchema } : {}),
        name: key,
        ...(mcp ? { mcp } : {}),
        ...(outputSchema ? { outputSchema } : {}),
      }
    })
  return inspected.length ? inspected : undefined
}
