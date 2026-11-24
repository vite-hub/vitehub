import { isRecord } from "@vite-hub/internal/object"

type JsonObject = Record<string, unknown>

/** The part of a Standard Schema that the codemod runs. */
export interface FieldSchema {
  "~standard": { vendor: string, validate: (value: unknown) => unknown }
}

function isFieldSchema(value: unknown): value is FieldSchema {
  const standard = isRecord(value) ? value["~standard"] : undefined
  return isRecord(standard) && typeof standard.vendor === "string" && typeof standard.validate === "function"
}

function valibotObject(schema: JsonObject, seen = new Set<JsonObject>()): JsonObject | undefined {
  if (seen.has(schema)) return undefined
  seen.add(schema)
  if (isRecord(schema.entries)) return schema.entries
  const inner: unknown = schema.type === "lazy" && typeof schema.getter === "function" ? Reflect.apply(schema.getter, schema, [undefined]) : schema.wrapped
  return isRecord(inner) ? valibotObject(inner, seen) : undefined
}

function zodObject(schema: JsonObject, seen = new Set<JsonObject>()): JsonObject | undefined {
  if (seen.has(schema)) return undefined
  seen.add(schema)
  const definition = isRecord(schema._zod) && isRecord(schema._zod.def) ? schema._zod.def : undefined
  if (!definition) return undefined
  if (definition.type === "object" && isRecord(definition.shape)) return definition.shape
  let inner = definition.type === "pipe" ? definition.in : definition.innerType
  if (definition.type === "lazy" && typeof definition.getter === "function") inner = Reflect.apply(definition.getter, definition, [])
  return isRecord(inner) ? zodObject(inner, seen) : undefined
}

const zod3Wrappers: Record<string, string> = {
  ZodBranded: "type",
  ZodCatch: "innerType",
  ZodDefault: "innerType",
  ZodEffects: "schema",
  ZodNullable: "innerType",
  ZodOptional: "innerType",
  ZodPipeline: "in",
  ZodReadonly: "innerType",
}

function zod3Object(schema: JsonObject): JsonObject | undefined {
  const definition = isRecord(schema._def) && typeof schema._def.typeName === "string" ? schema._def : undefined
  if (!definition) return undefined
  if (definition.typeName === "ZodObject") {
    const shape: unknown = typeof definition.shape === "function" ? Reflect.apply(definition.shape, definition, []) : definition.shape
    return isRecord(shape) ? shape : undefined
  }
  const inner = zod3Wrappers[String(definition.typeName)]
  const wrapped = inner ? definition[inner] : undefined
  return isRecord(wrapped) ? zod3Object(wrapped) : undefined
}

function childSchema(schema: JsonObject, key: string): unknown {
  const vendor = isFieldSchema(schema) ? schema["~standard"].vendor : undefined
  const entries = vendor === "valibot" ? valibotObject(schema) : vendor === "zod" ? zodObject(schema) ?? zod3Object(schema) : undefined
  return entries && Object.hasOwn(entries, key) ? entries[key] : undefined
}

/**
 * The Standard Schema of one `runtimeConfig` field in the `$schema` object, by its path in `runtimeConfig`,
 * such as `["public", "apiBase"]`. Returns `undefined` when the vendor's object shape cannot be read.
 */
export function fieldSchema(schema: unknown, path: readonly string[]): FieldSchema | undefined {
  let current = schema
  for (const key of path) current = isRecord(current) ? childSchema(current, key) : undefined
  return isFieldSchema(current) ? current : undefined
}

async function standardRejection(schema: FieldSchema, value: unknown): Promise<string | false | undefined> {
  try {
    const result: unknown = await schema["~standard"].validate(value)
    if (!isRecord(result)) return undefined
    if (!Array.isArray(result.issues) || !result.issues.length) return false
    const issue: unknown = result.issues[0]
    return isRecord(issue) && typeof issue.message === "string" && issue.message ? issue.message : "the value is not valid"
  }
  catch {
    return undefined
  }
}

const formatPatterns: Record<string, RegExp> = {
  email: /^[^\s@]+@[^\s@]+$/,
  uuid: /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i,
}

function stringRejection(node: JsonObject, value: string): string | undefined {
  const length = [...value].length
  if (typeof node.minLength === "number" && length < node.minLength) return `minimum length ${node.minLength}`
  if (typeof node.maxLength === "number" && length > node.maxLength) return `maximum length ${node.maxLength}`
  if (typeof node.pattern === "string") {
    try {
      if (!new RegExp(node.pattern, "u").test(value)) return `the pattern ${node.pattern}`
    }
    catch {}
  }
  if (typeof node.format === "string") {
    const format = node.format
    const valid = format === "uri" || format === "url" ? URL.canParse(value) : formatPatterns[format]?.test(value) ?? value !== ""
    if (!valid) return `the ${format === "uri" || format === "url" ? "URL" : format} format`
  }
  return undefined
}

function decimalParts(value: number) {
  const [mantissa = "", exponent = "0"] = String(value).split("e")
  const [whole = "", fraction = ""] = mantissa.split(".")
  return { digits: BigInt(whole + fraction), scale: Number(exponent) - fraction.length }
}

function isDecimalMultiple(value: number, divisor: number): boolean {
  const left = decimalParts(value)
  const right = decimalParts(divisor)
  const scale = Math.min(left.scale, right.scale)
  return (left.digits * 10n ** BigInt(left.scale - scale)) % (right.digits * 10n ** BigInt(right.scale - scale)) === 0n
}

function numberRejection(node: JsonObject, value: number): string | undefined {
  if (node.type === "integer" && !Number.isInteger(value)) return "the integer rule"
  if (typeof node.minimum === "number" && value < node.minimum) return `minimum ${node.minimum}`
  if (typeof node.maximum === "number" && value > node.maximum) return `maximum ${node.maximum}`
  if (typeof node.exclusiveMinimum === "number" && value <= node.exclusiveMinimum) return `exclusive minimum ${node.exclusiveMinimum}`
  if (typeof node.exclusiveMaximum === "number" && value >= node.exclusiveMaximum) return `exclusive maximum ${node.exclusiveMaximum}`
  if (typeof node.multipleOf === "number" && node.multipleOf > 0 && Number.isFinite(node.multipleOf) && Number.isFinite(value) && !isDecimalMultiple(value, node.multipleOf)) return `multiple of ${node.multipleOf}`
  return undefined
}

export interface DefaultCheck {
  /** The field's own schema, from `fieldSchema()`. */
  schema: FieldSchema | undefined
  /** The field's JSON Schema node, used when `schema` is missing or cannot run. */
  node: JsonObject
  /** The value that the module validated when the variable was not set. */
  input: unknown
  /** The default that Env would use, in the Env kind of the field. */
  value: unknown
}

/**
 * Why the field's schema rejects the default, or `undefined` when it accepts it. Runs the field's Standard Schema
 * on `input`, and checks `value` against the JSON Schema rules when the field has no schema that runs.
 */
export async function defaultRejection(check: DefaultCheck): Promise<string | undefined> {
  const standard = check.schema ? await standardRejection(check.schema, check.input) : undefined
  if (standard !== undefined) return standard || undefined
  if (typeof check.value === "string") return stringRejection(check.node, check.value)
  if (typeof check.value === "number") return numberRejection(check.node, check.value)
  return undefined
}
