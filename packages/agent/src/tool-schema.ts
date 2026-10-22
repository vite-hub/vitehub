import { withValibotJsonSchema } from "@vite-hub/internal/valibot"

import { isCallableMember, isRuntimeRecord } from "./internal/runtime-type.ts"
import { copyToolWithOverrides } from "./tool-runtime.ts"

import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import type { AgentToolSchema, AgentToolSet } from "./types.ts"

type JsonStandardSchema = AgentToolSchema & StandardJSONSchemaV1

/** Recognize own markers, with bounded lazy initialization for Zod 4 schemas. */
export function hasAgentToolStandardSchema(schema: AgentToolSchema | Record<string, unknown>): boolean {
  try {
    if (Object.hasOwn(schema, "~standard")) return true
    // Zod 4 puts its lazy marker on the prototype and brands each schema with _zod.
    const zod: unknown = Object.getOwnPropertyDescriptor(schema, "_zod")?.value
    if (!isRuntimeRecord(zod)) return false
    const traits: unknown = Object.getOwnPropertyDescriptor(zod, "traits")?.value
    if (!(traits instanceof Set) || !traits.has("$ZodType")) return false
    Reflect.get(schema, "~standard")
    return Object.hasOwn(schema, "~standard")
  }
  catch {
    return false
  }
}

/** Add JSON Schema conversion to Valibot's Standard Schema validation contract. Providers get draft-07. */
export function withAgentToolJsonSchema<TSchema extends AgentToolSchema>(schema: TSchema): TSchema {
  if (!hasAgentToolStandardSchema(schema)) return schema
  const standard = schema["~standard"]
  if (!standard) return schema
  // SAFETY: The own marker is checked above; JSON Schema conversion is optional on Standard Schema.
  const converts = Object.hasOwn(standard, "jsonSchema") && Boolean((standard as Partial<StandardJSONSchemaV1["~standard"]>).jsonSchema)
  // SAFETY: Valibot exposes async metadata; ownership is checked before reading this optional field.
  if (!converts && standard.vendor === "valibot" && Object.hasOwn(schema, "async") && (schema as { async?: unknown }).async === true) {
    throw new Error("[vitehub] Async Valibot Agent tool schemas cannot be converted to JSON Schema.")
  }
  // SAFETY: The own `~standard` marker above makes this branch of AgentToolSchema a Standard Schema.
  return withValibotJsonSchema(schema as TSchema & StandardSchemaV1, { target: "draft-07" })
}

export function agentToolJsonSchema(schema: AgentToolSchema | undefined, direction: "input" | "output"): Record<string, unknown> | undefined {
  if (!schema) return
  const normalized = withAgentToolJsonSchema(schema)
  if (!Object.hasOwn(normalized, "~standard") || !normalized["~standard"]) {
    // SAFETY: The alternate AgentToolSchema branch is a JSON Schema object.
    return normalized as Record<string, unknown>
  }
  // SAFETY: The own Standard Schema marker is checked above; optional conversion metadata is checked below.
  const standard = (normalized as JsonStandardSchema)["~standard"]
  if (!Object.hasOwn(standard, "jsonSchema") || !standard.jsonSchema) return
  // SAFETY: Runtime feature detection checks the Standard JSON Schema method before calling it.
  const jsonSchema = standard.jsonSchema[direction]
  return isCallableMember(jsonSchema) ? jsonSchema({ target: "draft-07" }) : undefined
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
