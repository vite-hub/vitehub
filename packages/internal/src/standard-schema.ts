import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"

export type StandardJsonSchemaTarget = StandardJSONSchemaV1.Target
export type StandardJsonSchemaDirection = "input" | "output"

function readOwn(value: unknown, key: string): unknown {
  if (value === null || Object(value) !== value) return
  try {
    // Zod 4 defines `~standard` lazily on the prototype, so read through the getter instead of own properties.
    return Reflect.get(Object(value), key)
  }
  catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

/** Whether a value carries a Standard Schema `~standard.validate` function. */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  const standard = readOwn(value, "~standard")
  return isRecord(standard) && readOwn(standard, "validate") instanceof Function
}

/**
 * Read a Standard JSON Schema projection without throwing.
 *
 * Returns `undefined` when the schema has no `~standard.jsonSchema`, when the library cannot represent the type
 * (Zod throws for `Date`), or when the projection is not an object. Callers decide how to fall back.
 */
export function standardJsonSchema(
  schema: unknown,
  direction: StandardJsonSchemaDirection,
  target: StandardJsonSchemaTarget = "draft-2020-12",
): Record<string, unknown> | undefined {
  const jsonSchema = readOwn(readOwn(schema, "~standard"), "jsonSchema")
  const project = readOwn(jsonSchema, direction)
  if (!(project instanceof Function)) return
  try {
    const result: unknown = project({ target })
    return isRecord(result) ? result : undefined
  }
  catch {
    return undefined
  }
}

/** Run a Standard Schema validator and await its result. */
export async function validateStandardSchema<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  value: unknown,
): Promise<StandardSchemaV1.Result<StandardSchemaV1.InferOutput<TSchema>>> {
  return await schema["~standard"].validate(value)
}

/** Readable dot path for a Standard Schema issue path, such as `tags.0` or `author.name`. */
export function standardIssuePath(issue: StandardSchemaV1.Issue): Array<string | number> {
  return (issue.path ?? []).map((segment) => {
    const key = isRecord(segment) && "key" in segment ? segment.key : segment
    return Number(key) === key ? key : String(key)
  })
}
