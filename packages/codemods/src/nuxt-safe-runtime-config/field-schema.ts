import { isRecord, isRecordOrFunction } from "@vite-hub/internal/object"

type JsonObject = Record<string, unknown>

/** The part of a Standard Schema that the codemod runs. */
export interface FieldSchema {
  "~standard": { vendor: string, validate: (value: unknown) => unknown }
}

function isFieldSchema(value: unknown): value is FieldSchema {
  const standard = isRecordOrFunction(value) ? value["~standard"] : undefined
  return isRecord(standard) && typeof standard.vendor === "string" && typeof standard.validate === "function"
}

/** One property read or method call on a schema, such as `.entries` or `.unwrap()`. */
export type AccessStep = { kind: "property", name: string } | { kind: "call", name: string, args: string[] }

/** The schema of one field and the steps that read it from the root schema. */
export interface FieldAccess {
  schema: FieldSchema
  steps: AccessStep[]
}

interface Hop {
  value: unknown
  steps: AccessStep[]
}

const property = (name: string): AccessStep => ({ kind: "property", name })
const call = (name: string, ...args: string[]): AccessStep => ({ kind: "call", name, args })

function runStep(target: unknown, step: AccessStep): unknown {
  if ((typeof target !== "object" && typeof target !== "function") || target === null) return undefined
  try {
    const value: unknown = Reflect.get(target, step.name)
    if (step.kind === "property") return value
    return typeof value === "function" ? Reflect.apply(value, target, step.args) : undefined
  }
  catch {
    return undefined
  }
}

/** Runs the steps on `schema` the same way the generated module reads them. */
export function runSteps(schema: unknown, steps: readonly AccessStep[]): unknown {
  return steps.reduce<unknown>((target, step) => runStep(target, step), schema)
}

function firstMatch(schema: unknown, expected: unknown, candidates: readonly AccessStep[][]): Hop | undefined {
  const steps = candidates.find(entry => runSteps(schema, entry) === expected)
  return steps ? { value: expected, steps } : undefined
}

function firstValue(schema: unknown, candidates: readonly AccessStep[][], accept: (value: unknown) => value is JsonObject): Hop | undefined {
  for (const steps of candidates) {
    const value = runSteps(schema, steps)
    if (accept(value)) return { value, steps }
  }
  return undefined
}

function joinHop(hop: Hop | undefined, child: (inner: JsonObject) => Hop | undefined): Hop | undefined {
  const inner = hop && isRecord(hop.value) ? child(hop.value) : undefined
  return hop && inner && { value: inner.value, steps: [...hop.steps, ...inner.steps] }
}

function valibotChild(schema: JsonObject, key: string, seen = new Set<JsonObject>()): Hop | undefined {
  if (seen.has(schema)) return undefined
  seen.add(schema)
  if (isRecord(schema.entries)) return Object.hasOwn(schema.entries, key) ? { value: schema.entries[key], steps: [property("entries"), property(key)] } : undefined
  const hop = schema.type === "lazy" && typeof schema.getter === "function"
    ? firstValue(schema, [[call("getter")]], isRecord)
    : isRecord(schema.wrapped) ? { value: schema.wrapped, steps: [property("wrapped")] } : undefined
  return joinHop(hop, inner => valibotChild(inner, key, seen))
}

function isZodSchema(value: unknown): value is JsonObject {
  return isRecord(value) && isRecord(value._zod)
}

function zodChild(schema: JsonObject, key: string, seen = new Set<JsonObject>()): Hop | undefined {
  if (seen.has(schema)) return undefined
  seen.add(schema)
  const definition = isRecord(schema._zod) && isRecord(schema._zod.def) ? schema._zod.def : undefined
  if (!definition) return undefined
  if (definition.type === "object" && isRecord(definition.shape)) {
    if (!Object.hasOwn(definition.shape, key)) return undefined
    const shape = firstMatch(schema, definition.shape, [[property("shape")], [property("def"), property("shape")], [property("_zod"), property("def"), property("shape")]])
    return shape && { value: definition.shape[key], steps: [...shape.steps, property(key)] }
  }
  if (definition.type === "lazy" && typeof definition.getter === "function") {
    const hop = firstValue(schema, [[call("unwrap")], [property("def"), call("getter")], [property("_zod"), property("def"), call("getter")]], isZodSchema)
    return joinHop(hop, inner => zodChild(inner, key, seen))
  }
  const name = definition.type === "pipe" ? "in" : "innerType"
  const inner = definition[name]
  if (!isRecord(inner)) return undefined
  const hop = firstMatch(schema, inner, [...(name === "innerType" ? [[call("unwrap")]] : [[property("in")]]), [property("def"), property(name)], [property("_zod"), property("def"), property(name)]])
  return joinHop(hop, inner => zodChild(inner, key, seen))
}

const zod3Wrappers: Record<string, { inner: string, methods: string[] }> = {
  ZodBranded: { inner: "type", methods: ["unwrap"] },
  ZodCatch: { inner: "innerType", methods: ["removeCatch"] },
  ZodDefault: { inner: "innerType", methods: ["removeDefault"] },
  ZodEffects: { inner: "schema", methods: ["innerType"] },
  ZodNullable: { inner: "innerType", methods: ["unwrap"] },
  ZodOptional: { inner: "innerType", methods: ["unwrap"] },
  ZodPipeline: { inner: "in", methods: [] },
  ZodReadonly: { inner: "innerType", methods: ["unwrap"] },
}

function zod3Child(schema: JsonObject, key: string): Hop | undefined {
  const definition = isRecord(schema._def) && typeof schema._def.typeName === "string" ? schema._def : undefined
  if (!definition) return undefined
  if (definition.typeName === "ZodObject") {
    const shape: unknown = typeof definition.shape === "function" ? Reflect.apply(definition.shape, definition, []) : definition.shape
    if (!isRecord(shape) || !Object.hasOwn(shape, key)) return undefined
    const hop = firstMatch(schema, shape, [[property("shape")], [property("_def"), call("shape")]])
    return hop && { value: shape[key], steps: [...hop.steps, property(key)] }
  }
  const wrapper = zod3Wrappers[String(definition.typeName)]
  const inner = wrapper ? definition[wrapper.inner] : undefined
  if (!wrapper || !isRecord(inner)) return undefined
  const hop = firstMatch(schema, inner, [...wrapper.methods.map(method => [call(method)]), [property("_def"), property(wrapper.inner)]])
  const child = hop && zod3Child(inner, key)
  return hop && child && { value: child.value, steps: [...hop.steps, ...child.steps] }
}

function arktypeChild(schema: JsonObject, key: string): Hop | undefined {
  const step = call("get", key)
  const value = runSteps(schema, [step])
  return isFieldSchema(value) ? { value, steps: [step] } : undefined
}

function childSchema(schema: JsonObject, key: string): Hop | undefined {
  const vendor = isFieldSchema(schema) ? schema["~standard"].vendor : undefined
  if (vendor === "valibot") return valibotChild(schema, key)
  if (vendor === "zod") return zodChild(schema, key) ?? zod3Child(schema, key)
  if (vendor === "arktype") return arktypeChild(schema, key)
  return undefined
}

/**
 * The Standard Schema of one `runtimeConfig` field in the `$schema` object, by its path in `runtimeConfig`, such as
 * `["public", "apiBase"]`, with the property reads and calls that return it. Each step is checked on the schema.
 * Returns `undefined` when the vendor's object shape cannot be read.
 */
export function fieldAccess(schema: unknown, path: readonly string[]): FieldAccess | undefined {
  let current: unknown = schema
  const steps: AccessStep[] = []
  for (const key of path) {
    const hop = isRecordOrFunction(current) ? childSchema(current, key) : undefined
    if (!hop) return undefined
    current = hop.value
    steps.push(...hop.steps)
  }
  return isFieldSchema(current) ? { schema: current, steps } : undefined
}

/** The Standard Schema of one `runtimeConfig` field in the `$schema` object. See `fieldAccess()`. */
export function fieldSchema(schema: unknown, path: readonly string[]): FieldSchema | undefined {
  return fieldAccess(schema, path)?.schema
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

function provesNotMultiple(value: number, divisor: number): boolean {
  return Number.isSafeInteger(value) && Number.isSafeInteger(divisor) && divisor > 0 && value % divisor !== 0
}

function numberRejection(node: JsonObject, value: number): string | undefined {
  if (node.type === "integer" && !Number.isInteger(value)) return "the integer rule"
  if (typeof node.minimum === "number" && value < node.minimum) return `minimum ${node.minimum}`
  if (typeof node.maximum === "number" && value > node.maximum) return `maximum ${node.maximum}`
  if (typeof node.exclusiveMinimum === "number" && value <= node.exclusiveMinimum) return `exclusive minimum ${node.exclusiveMinimum}`
  if (typeof node.exclusiveMaximum === "number" && value >= node.exclusiveMaximum) return `exclusive maximum ${node.exclusiveMaximum}`
  if (typeof node.multipleOf === "number" && provesNotMultiple(value, node.multipleOf)) return `multiple of ${node.multipleOf}`
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
