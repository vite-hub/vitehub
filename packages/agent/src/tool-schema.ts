import { toJsonSchema } from "@valibot/to-json-schema"

import { copyToolWithOverrides } from "./tool-runtime.ts"

import type { BaseIssue, BaseSchema } from "valibot"
import type { StandardJSONSchemaV1 } from "@standard-schema/spec"
import type { AgentToolSchema, AgentToolSet } from "./types.ts"

type JsonStandardSchema = AgentToolSchema & StandardJSONSchemaV1

/** Add JSON Schema conversion to Valibot's Standard Schema validation contract. */
export function withAgentToolJsonSchema<TSchema extends AgentToolSchema>(schema: TSchema): TSchema {
  if (!("~standard" in schema)) return schema
  const standard = schema["~standard"]
  if (!standard) return schema
  if ("jsonSchema" in standard && standard.jsonSchema) return schema
  if (standard.vendor !== "valibot") return schema
  if ("async" in schema && schema.async === true) {
    throw new Error("[vitehub] Async Valibot Agent tool schemas cannot be converted to JSON Schema.")
  }
  // SAFETY: Valibot marks its synchronous schemas with the Standard Schema vendor value used above.
  const valibot = schema as BaseSchema<unknown, unknown, BaseIssue<unknown>>
  const jsonSchema: StandardJSONSchemaV1["~standard"]["jsonSchema"] = {
    // SAFETY: Valibot's JsonSchema object is a JSON Schema record; its type omits the index signature.
    input: () => toJsonSchema(valibot, { target: "draft-07", typeMode: "input", errorMode: "ignore" }) as Record<string, unknown>,
    // SAFETY: Valibot's JsonSchema object is a JSON Schema record; its type omits the index signature.
    output: () => toJsonSchema(valibot, { target: "draft-07", typeMode: "output", errorMode: "ignore" }) as Record<string, unknown>,
  }
  // SAFETY: The wrapper keeps Valibot validation and adds only Standard JSON Schema conversion.
  return { ...schema, "~standard": { ...standard, jsonSchema } } as TSchema
}

export function agentToolJsonSchema(schema: AgentToolSchema | undefined, direction: "input" | "output"): Record<string, unknown> | undefined {
  if (!schema) return
  const normalized = withAgentToolJsonSchema(schema)
  if (!("~standard" in normalized) || !normalized["~standard"]) {
    // SAFETY: The alternate AgentToolSchema branch is a JSON Schema object.
    return normalized as Record<string, unknown>
  }
  // SAFETY: Runtime feature detection checks the Standard JSON Schema method before calling it.
  const jsonSchema = (normalized as JsonStandardSchema)["~standard"].jsonSchema?.[direction]
  return jsonSchema?.({ target: "draft-07" })
}

export function withAgentToolJsonSchemas<TTools extends AgentToolSet>(tools: TTools): TTools {
  // SAFETY: Tool names and handlers are preserved; only schema objects gain JSON Schema conversion.
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    const overrides: Pick<AgentToolSet[string], "inputSchema" | "outputSchema"> = {}
    if (tool.inputSchema) overrides.inputSchema = withAgentToolJsonSchema(tool.inputSchema)
    if (tool.outputSchema) overrides.outputSchema = withAgentToolJsonSchema(tool.outputSchema)
    return [name, copyToolWithOverrides(tool, overrides)]
  })) as TTools
}
