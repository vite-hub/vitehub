import { toJsonSchema } from "@valibot/to-json-schema"

import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"

/** The JSON Schema dialects that Valibot converts to. */
export type ValibotJsonSchemaTarget = "draft-07" | "draft-2020-12" | "openapi-3.0"

const valibotTargets: ReadonlySet<string> = new Set<ValibotJsonSchemaTarget>(["draft-07", "draft-2020-12", "openapi-3.0"])

function isValibotTarget(value: unknown): value is ValibotJsonSchemaTarget {
  return valibotTargets.has(String(value))
}

/**
 * Add Standard JSON Schema conversion to a plain Valibot schema. Valibot schemas validate as Standard Schema but carry
 * no JSON Schema, so forms, tools, and model providers would get no shape for them. Other schemas, Valibot schemas that
 * already convert, and async Valibot schemas return unchanged. The copy keeps every Valibot property, so validation
 * does not change.
 *
 * `target` fixes the JSON Schema dialect. Without it, each conversion uses the dialect that the caller asks for.
 */
export function withValibotJsonSchema<TSchema extends StandardSchemaV1>(schema: TSchema, options: { target?: ValibotJsonSchemaTarget } = {}): TSchema {
  const standard = schema["~standard"]
  if (standard.vendor !== "valibot" || Reflect.get(schema, "async") === true) return schema
  // SAFETY: JSON Schema conversion is optional on Standard Schema; its presence is checked before it is read.
  if (Object.hasOwn(standard, "jsonSchema") && (standard as Partial<StandardJSONSchemaV1["~standard"]>).jsonSchema) return schema
  const convert = (typeMode: "input" | "output") => (request: StandardJSONSchemaV1.Options): Record<string, unknown> => {
    const target = options.target ?? request.target
    if (!isValibotTarget(target)) throw new Error(`[vitehub] Valibot cannot convert a schema to the ${String(target)} JSON Schema target.`)
    // SAFETY: The vendor marks a Valibot schema, and Valibot's JsonSchema object is a JSON Schema record without an index signature.
    return toJsonSchema(schema as never, { target, typeMode, errorMode: "ignore" }) as Record<string, unknown>
  }
  // SAFETY: The copy keeps Valibot validation and adds only Standard JSON Schema conversion.
  return { ...schema, "~standard": { ...standard, jsonSchema: { input: convert("input"), output: convert("output") } } } as TSchema
}
