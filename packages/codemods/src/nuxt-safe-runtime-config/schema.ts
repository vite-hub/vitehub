import { createRequire } from "node:module"
import { join } from "node:path"

import { toJsonSchema } from "@valibot/to-json-schema"

import { isRecordOrFunction } from "@vite-hub/internal/object"

import { codemodError } from "../error-diagnostics.ts"
import { defaultRejection, fieldAccess, fieldSchema, hasSchemaDefault, isAsyncSchema } from "./field-schema.ts"
import { flatPublicName, looksSecret, nuxtVariableName, pathLabel } from "./fields.ts"

import type { BaseIssue, BaseSchema } from "valibot"
import type { FieldAccess } from "./field-schema.ts"
import type { EnvField, EnvFieldKind, Framework, LiteralValue, PlannedFollowUp } from "./fields.ts"
import type { RuntimeConfigValue } from "./nuxt-config.ts"

type JsonObject = Record<string, unknown>

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isValibotSchema(value: unknown): value is BaseSchema<unknown, unknown, BaseIssue<unknown>> {
  return isRecord(value) && value.kind === "schema" && isRecord(value["~standard"]) && value["~standard"].vendor === "valibot"
}

function zod3Definition(schema: unknown): JsonObject | undefined {
  return isRecord(schema) && isRecord(schema._def) && typeof schema._def.typeName === "string" ? schema._def : undefined
}

function zod3OptionalInput(schema: unknown): boolean {
  const definition = zod3Definition(schema)
  if (!definition) return false
  switch (definition.typeName) {
    case "ZodOptional":
    case "ZodDefault": return true
    case "ZodEffects": return zod3OptionalInput(definition.schema)
    case "ZodPipeline": return zod3OptionalInput(definition.in)
    case "ZodBranded": return zod3OptionalInput(definition.type)
    case "ZodNullable":
    case "ZodReadonly": return zod3OptionalInput(definition.innerType)
    default: return false
  }
}

/** Converts supported Zod 3 inputs. Unsupported types and wrappers stay unknown for manual migration. */
function zod3ToJsonSchema(schema: unknown): JsonObject {
  const definition = zod3Definition(schema)
  if (!definition) return {}
  const checks = Array.isArray(definition.checks) ? definition.checks.filter(isRecord) : []
  switch (definition.typeName) {
    case "ZodString": {
      const node: JsonObject = { type: "string" }
      for (const check of checks) {
        if (check.kind === "url") node.format = "uri"
        else if (check.kind === "email" || check.kind === "uuid") node.format = check.kind
        else if (check.kind === "min" && typeof check.value === "number") node.minLength = check.value
        else if (check.kind === "max" && typeof check.value === "number") node.maxLength = check.value
        else if (check.kind === "length" && typeof check.value === "number") node.minLength = node.maxLength = check.value
        else if (check.kind === "regex" && check.regex instanceof RegExp) node.pattern = check.regex.source
      }
      return node
    }
    case "ZodNumber": {
      const node: JsonObject = { type: checks.some(check => check.kind === "int") ? "integer" : "number" }
      for (const check of checks) {
        if (check.kind === "min" && typeof check.value === "number") node[check.inclusive === false ? "exclusiveMinimum" : "minimum"] = check.value
        if (check.kind === "max" && typeof check.value === "number") node[check.inclusive === false ? "exclusiveMaximum" : "maximum"] = check.value
      }
      return node
    }
    case "ZodBoolean": return { type: "boolean" }
    case "ZodEnum": return Array.isArray(definition.values) ? { type: "string", enum: definition.values } : {}
    case "ZodNativeEnum": {
      const values = definition.values
      if (!isRecord(values)) return {}
      // Numeric TypeScript enums also contain reverse mappings from numbers to member names.
      return { enum: Object.values(values).filter(value => (typeof value === "string" || typeof value === "number") && typeof values[value] !== "number") }
    }
    case "ZodLiteral": return { const: definition.value }
    case "ZodOptional": return zod3ToJsonSchema(definition.innerType)
    case "ZodNullable": return { anyOf: [zod3ToJsonSchema(definition.innerType), { type: "null" }] }
    case "ZodDefault": {
      const node = zod3ToJsonSchema(definition.innerType)
      try {
        const value: unknown = typeof definition.defaultValue === "function" ? Reflect.apply(definition.defaultValue, undefined, []) : undefined
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") node.default = value
      }
      catch {}
      return node
    }
    case "ZodEffects": return zod3ToJsonSchema(definition.schema)
    case "ZodPipeline": return zod3ToJsonSchema(definition.in)
    case "ZodBranded": return zod3ToJsonSchema(definition.type)
    case "ZodReadonly": return zod3ToJsonSchema(definition.innerType)
    case "ZodUnion": return { anyOf: (Array.isArray(definition.options) ? definition.options : []).map(zod3ToJsonSchema) }
    case "ZodArray": return { type: "array" }
    case "ZodObject": {
      const shape: unknown = typeof definition.shape === "function" ? Reflect.apply(definition.shape, undefined, []) : definition.shape
      if (!isRecord(shape)) return { type: "object" }
      const required = Object.entries(shape).filter(([, child]) => !zod3OptionalInput(child)).map(([key]) => key)
      return { type: "object", properties: Object.fromEntries(Object.entries(shape).map(([key, child]) => [key, zod3ToJsonSchema(child)])), required }
    }
    default: return {}
  }
}

/** Zod 4 before 4.2 has no converter on the schema, but the package exports `toJSONSchema()`. Use the app's copy. */
function zodPackageJsonSchema(schema: unknown, cwd: string | undefined): JsonObject | undefined {
  if (!cwd || !zodDefinition(schema)) return undefined
  try {
    const zod: unknown = createRequire(join(cwd, "package.json"))("zod")
    const convert = isRecord(zod) ? zod.toJSONSchema : undefined
    if (typeof convert !== "function") return undefined
    const output: unknown = Reflect.apply(convert, zod, [schema, { io: "input", unrepresentable: "any" }])
    return isRecord(output) ? output : undefined
  }
  catch {
    return undefined
  }
}

/**
 * Converts a Standard Schema to the JSON Schema of its input, the shape that host values must have. `cwd` lets
 * the converter load the app's own Zod for Zod 4 versions before 4.2.
 */
export async function schemaToJsonSchema(schema: unknown, cwd?: string): Promise<JsonObject> {
  const standard = isRecordOrFunction(schema) ? schema["~standard"] : undefined
  if (!isRecordOrFunction(schema) || !isRecord(standard)) {
    throw codemodError("The $schema is not a Standard Schema. Use a Valibot, Zod, or ArkType schema.")
  }
  const vendor = typeof standard.vendor === "string" ? standard.vendor : "unknown"
  let nativeError: unknown
  const converter = isRecord(standard.jsonSchema) ? standard.jsonSchema.input : undefined
  if (typeof converter === "function") {
    try {
      const output: unknown = await Reflect.apply(converter, standard.jsonSchema, [{ target: "draft-2020-12" }])
      if (isRecord(output)) return output
    }
    catch (error) {
      nativeError = error
    }
  }
  if (isValibotSchema(schema)) {
    return Object.fromEntries(Object.entries(toJsonSchema(schema, { errorMode: "ignore" })))
  }
  if (zod3Definition(schema)) return zod3ToJsonSchema(schema)
  const fromPackage = zodPackageJsonSchema(schema, cwd)
  if (fromPackage) return fromPackage
  const arkConverter = schema.toJsonSchema
  if (typeof arkConverter === "function") {
    try {
      const output: unknown = Reflect.apply(arkConverter, schema, [])
      if (isRecord(output)) return output
    }
    catch (error) {
      nativeError = error
    }
  }
  throw codemodError(`Cannot convert the ${vendor} $schema to JSON Schema${nativeError ? `: ${errorText(nativeError)}` : ""}. Zod 3, Zod 4.2 or newer, Valibot 1, and ArkType 2 are supported.`)
}

// Valibot validations that @valibot/to-json-schema writes as JSON Schema keywords. Other actions are reported.
const valibotJsonValidations = new Set([
  "base64", "bic", "decimal", "description", "digits", "domain", "email", "emoji", "empty", "ends_with", "entries", "examples", "gt_value",
  "hash", "hex_color", "hexadecimal", "imei", "includes", "integer", "ip", "ipv4", "ipv6", "iso_date", "iso_date_time", "iso_time",
  "iso_time_second", "iso_timestamp", "iso_week", "isrc", "jws_compact", "ksuid", "length", "lt_value", "mac", "mac48", "mac64",
  "max_entries", "max_length", "max_value", "metadata", "min_entries", "min_length", "min_value", "multiple_of", "nanoid", "non_empty",
  "not_value", "not_values", "octal", "regex", "rfc_email", "safe_integer", "slug", "starts_with", "title", "ulid", "url", "uuid",
  "value", "values",
])

/** Rules that JSON Schema cannot hold, by dotted path, and the paths whose rules change the value. */
export class SchemaIssues extends Map<string, string[]> {
  readonly transforms = new Set<string>()
}

function addIssue(issues: SchemaIssues, path: readonly string[], issue: string): void {
  const key = path.join(".")
  issues.set(key, [...(issues.get(key) ?? []), issue])
}

function valibotIssues(schema: unknown, path: string[], issues: SchemaIssues): void {
  if (!isRecord(schema)) return
  if (Array.isArray(schema.pipe)) {
    for (const action of schema.pipe.slice(1)) {
      if (!isRecord(action) || typeof action.type !== "string") continue
      if (action.kind === "transformation") addIssue(issues, path, `the Valibot ${action.type} action`)
      else if (action.kind === "validation" && !valibotJsonValidations.has(action.type)) addIssue(issues, path, action.type === "check" ? "a Valibot check" : `the Valibot ${action.type} check`)
    }
  }
  if (isRecord(schema.entries) && ["object", "loose_object", "strict_object", "object_with_rest"].includes(String(schema.type))) {
    for (const [key, entry] of Object.entries(schema.entries)) valibotIssues(entry, [...path, key], issues)
  }
  else if ("wrapped" in schema) {
    valibotIssues(schema.wrapped, path, issues)
  }
  else if (schema.type === "custom" || schema.type === "lazy") {
    addIssue(issues, path, `a Valibot ${schema.type} schema`)
  }
}

function zodDefinition(schema: unknown): JsonObject | undefined {
  return isRecord(schema) && isRecord(schema._zod) && isRecord(schema._zod.def) ? schema._zod.def : undefined
}

function zodIssues(schema: unknown, path: string[], issues: SchemaIssues): void {
  const definition = zodDefinition(schema)
  if (!definition) return
  for (const check of Array.isArray(definition.checks) ? definition.checks : []) {
    const kind = zodDefinition(check)?.check
    if (kind === "custom") addIssue(issues, path, "a Zod refinement")
    if (kind === "overwrite") addIssue(issues, path, "a Zod overwrite")
  }
  const type = definition.type
  if (type === "object" && isRecord(definition.shape)) {
    for (const [key, entry] of Object.entries(definition.shape)) zodIssues(entry, [...path, key], issues)
  }
  else if (type === "pipe") {
    const output = zodDefinition(definition.out)
    addIssue(issues, path, output?.type === "transform" ? "a Zod transform" : "a Zod pipe")
    zodIssues(definition.in, path, issues)
  }
  else if (type === "transform") {
    addIssue(issues, path, "a Zod transform")
  }
  else if (type === "custom" || type === "lazy") {
    addIssue(issues, path, `a Zod ${type} schema`)
  }
  else if ("innerType" in definition) {
    zodIssues(definition.innerType, path, issues)
  }
}

// Checks that zod3ToJsonSchema writes as JSON Schema keywords. Other checks need follow-ups.
const zod3JsonChecks = new Set(["url", "email", "uuid", "min", "max", "length", "regex", "int"])
const zod3TransformChecks = new Set(["trim", "toLowerCase", "toUpperCase"])

function zod3Issues(schema: unknown, path: string[], issues: SchemaIssues): void {
  const definition = zod3Definition(schema)
  if (!definition) return
  for (const check of Array.isArray(definition.checks) ? definition.checks : []) {
    if (!isRecord(check) || typeof check.kind !== "string") continue
    if (zod3TransformChecks.has(check.kind)) addIssue(issues, path, `a Zod ${check.kind} transform`)
    else if (!zod3JsonChecks.has(check.kind)) addIssue(issues, path, `the Zod ${check.kind} check`)
  }
  const type = definition.typeName
  // Coercion is input behavior, not a JSON Schema check. Report it for every type.
  if (definition.coerce === true) {
    const detail = type === "ZodBoolean"
      ? ', which turned every non-empty value, even "false", into true (Env reads true and false)'
      : type === "ZodNumber"
        ? ", which accepts empty or whitespace-only input as 0 (Env rejects it)"
        : ", whose accepted inputs differ from Env"
    addIssue(issues, path, `z.coerce.${String(type).slice(3).toLowerCase()}()${detail}`)
  }
  if (type === "ZodEffects") {
    const effect = isRecord(definition.effect) ? definition.effect.type : undefined
    addIssue(issues, path, effect === "refinement" ? "a Zod refinement" : effect === "preprocess" ? "a Zod preprocess" : "a Zod transform")
    zod3Issues(definition.schema, path, issues)
  }
  else if (type === "ZodPipeline") {
    addIssue(issues, path, "a Zod pipe")
    zod3Issues(definition.in, path, issues)
  }
  else if (type === "ZodUnion") {
    for (const option of Array.isArray(definition.options) ? definition.options : []) zod3Issues(option, path, issues)
  }
  else if (type === "ZodObject") {
    const shape: unknown = typeof definition.shape === "function" ? Reflect.apply(definition.shape, undefined, []) : definition.shape
    if (isRecord(shape)) for (const [key, child] of Object.entries(shape)) zod3Issues(child, [...path, key], issues)
  }
  else if (type === "ZodLazy" || type === "ZodAny" || type === "ZodUnknown") {
    addIssue(issues, path, `a Zod ${type.slice(3).toLowerCase()} schema`)
  }
  else if (type === "ZodBranded") {
    zod3Issues(definition.type, path, issues)
  }
  else if (type === "ZodOptional" || type === "ZodNullable" || type === "ZodDefault" || type === "ZodReadonly") {
    zod3Issues(definition.innerType, path, issues)
  }
  else if (type === "ZodCatch") {
    addIssue(issues, path, "a Zod catch fallback, which accepts missing or invalid input")
  }
}

function arktypeNarrows(json: unknown): boolean {
  if (Array.isArray(json)) return json.some(arktypeNarrows)
  if (!isRecord(json)) return false
  if (Array.isArray(json.predicate) && json.predicate.some(entry => typeof entry === "string")) return true
  return Object.values(json).some(arktypeNarrows)
}

function arktypeIssues(schema: unknown, path: string[], issues: SchemaIssues): void {
  if (!isRecordOrFunction(schema) || !isRecordOrFunction(schema.internal)) return
  const json = schema.json
  const object = schema.internal.kind !== "morph" && isRecord(json) && json.domain === "object" && json.proto === undefined
  if (!object) {
    if (schema.internal.includesTransform === true) {
      addIssue(issues, path, "an ArkType morph")
      issues.transforms.add(path.join("."))
    }
    if (arktypeNarrows(json)) addIssue(issues, path, "an ArkType narrow")
    return
  }
  if (Array.isArray(json.predicate) && json.predicate.some(entry => typeof entry === "string")) addIssue(issues, path, "an ArkType narrow")
  const props: unknown = schema.props
  for (const prop of Array.isArray(props) ? props : []) {
    if (isRecordOrFunction(prop) && typeof prop.key === "string") arktypeIssues(prop.value, [...path, prop.key], issues)
  }
}

function collectTransformPaths(schema: unknown, transforms: Set<string>): void {
  function visit(node: unknown, path: string[]): void {
    if (!isRecord(node)) return
    const mark = () => transforms.add(path.join("."))
    const at = (child: unknown, key: string) => visit(child, [...path, key])
    const samePath = (child: unknown) => visit(child, path)
    const entries = (shape: unknown) => {
      if (isRecord(shape)) for (const [key, child] of Object.entries(shape)) at(child, key)
    }
    const items = (values: unknown) => {
      if (Array.isArray(values)) values.forEach((child, index) => at(child, String(index)))
    }
    const options = (values: unknown) => {
      if (Array.isArray(values)) values.forEach(samePath)
    }

    const zod = zodDefinition(node)
    const definition = zod ?? zod3Definition(node)
    if (definition) {
      const checks = Array.isArray(definition.checks) ? definition.checks : []
      const effect = isRecord(definition.effect) ? definition.effect.type : undefined
      const changesValue = zod
        ? definition.type === "transform" || checks.some(check => zodDefinition(check)?.check === "overwrite")
        : effect === "transform" || effect === "preprocess" || checks.some(check => isRecord(check) && typeof check.kind === "string" && zod3TransformChecks.has(check.kind))
      if (changesValue) mark()
      switch (zod ? definition.type : definition.typeName) {
        case "object":
        case "ZodObject":
          entries(typeof definition.shape === "function" ? Reflect.apply(definition.shape, undefined, []) : definition.shape)
          at(definition.catchall, "*")
          break
        case "tuple":
        case "ZodTuple":
          items(definition.items)
          at(definition.rest, "*")
          break
        case "array":
        case "ZodArray":
          at(zod ? definition.element : definition.type, "*")
          break
        case "record":
        case "ZodRecord":
        case "map":
        case "ZodMap":
          at(definition.keyType, "*")
          at(definition.valueType, "*")
          break
        case "set":
        case "ZodSet":
          at(definition.valueType, "*")
          break
        case "union":
        case "ZodUnion":
        case "ZodDiscriminatedUnion":
          options(definition.options)
          break
        case "intersection":
        case "ZodIntersection":
          samePath(definition.left)
          samePath(definition.right)
          break
        case "pipe":
        case "ZodPipeline":
          samePath(definition.in)
          samePath(definition.out)
          break
        case "ZodEffects": samePath(definition.schema); break
        case "ZodBranded": samePath(definition.type); break
        default: samePath(definition.innerType)
      }
    }
    else if (node.kind === "schema" || node.kind === "transformation") {
      if (node.kind === "transformation") mark()
      if (Array.isArray(node.pipe)) {
        options(node.pipe)
        return
      }
      entries(node.entries)
      items(node.items)
      options(node.options)
      samePath(node.wrapped)
      at(node.item, "*")
      at(node.rest, "*")
      at(node.value, "*")
    }
  }
  visit(schema, [])
}

/** Rules that JSON Schema cannot hold, such as transforms and custom checks, by dotted path. `""` is the schema root. */
export function schemaIssues(schema: unknown): SchemaIssues {
  const issues = new SchemaIssues()
  if (isValibotSchema(schema)) valibotIssues(schema, [], issues)
  else if (zodDefinition(schema)) zodIssues(schema, [], issues)
  else if (zod3Definition(schema)) zod3Issues(schema, [], issues)
  else if (isRecordOrFunction(schema) && isRecord(schema["~standard"]) && schema["~standard"].vendor === "arktype") arktypeIssues(schema, [], issues)
  collectTransformPaths(schema, issues.transforms)
  return issues
}

export interface SchemaPlan {
  fields: EnvField[]
  /** Labels of `runtimeConfig` paths that stay in `runtimeConfig`, such as `public.tags`. */
  unmigrated: string[]
  followUps: PlannedFollowUp[]
  /** True when a field has a rule or a shape that only its schema can check, so a schema module would keep it. */
  needsSchemaModule: boolean
}

interface PlanInput {
  /** The `$schema` itself. Each kept default must pass its field's schema. */
  schema?: unknown
  schemaExports?: boolean
  jsonSchema: JsonObject
  issues: Map<string, string[]>
  runtimeConfig: Map<string, Pick<RuntimeConfigValue, "expression" | "json" | "literal" | "processEnv">>
  validateAtBuild?: boolean
  validateAtRuntime?: boolean
  rejectInvalidDefaults?: boolean
  framework?: Framework
}

function resolveReference(root: JsonObject, node: unknown): JsonObject {
  if (!isRecord(node)) return {}
  const reference = node.$ref
  if (typeof reference !== "string" || !reference.startsWith("#/")) return node
  let current: unknown = root
  for (const segment of reference.slice(2).split("/")) current = isRecord(current) ? current[segment] : undefined
  return isRecord(current) ? resolveReference(root, current) : {}
}

function stringValues(nodes: unknown[]): string[] | undefined {
  const values = nodes.map(node => isRecord(node) && typeof node.const === "string" ? node.const : undefined)
  return values.every(value => value !== undefined) ? values : undefined
}

type Leaf =
  | { kind: "boolean" | "integer" | "number" | "string", values?: undefined, nullable: boolean }
  | { kind: "enum", values: string[], nullable: boolean }
  | { kind: "array" | "object" | "union" | "unknown", values?: undefined, nullable: boolean }

/** The Env kind of one JSON Schema node, with `null` folded into `nullable`. */
export function describeLeaf(root: JsonObject, input: JsonObject): Leaf & { node: JsonObject } {
  let node = resolveReference(root, input)
  let nullable = false
  const variants = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined
  if (variants) {
    const resolved = variants.map(variant => resolveReference(root, variant))
    const nonNull = resolved.filter(variant => variant.type !== "null")
    nullable = nonNull.length !== resolved.length
    const values = stringValues(nonNull)
    if (values?.length) return { kind: "enum", values, nullable, node }
    if (nonNull.length !== 1 || !nonNull[0]) return { kind: "union", nullable, node }
    node = { ...nonNull[0], ...Object.fromEntries(Object.entries(node).filter(([key]) => key !== "anyOf" && key !== "oneOf")) }
  }
  let type = node.type
  if (Array.isArray(type)) {
    const types = type.filter(entry => entry !== "null")
    nullable ||= types.length !== type.length
    type = types.length === 1 ? types[0] : undefined
    if (types.length > 1) return { kind: "union", nullable, node }
  }
  if (Array.isArray(node.enum)) {
    const values = node.enum.filter(value => value !== null)
    nullable ||= values.length !== node.enum.length
    return values.every(value => typeof value === "string") && values.length
      ? { kind: "enum", values: values.filter(value => typeof value === "string"), nullable, node }
      : { kind: "union", nullable, node }
  }
  if (typeof node.const === "string") return { kind: "enum", values: [node.const], nullable, node }
  if (type === "string" || type === "number" || type === "integer" || type === "boolean" || type === "array" || type === "object") {
    return { kind: type, nullable, node }
  }
  return { kind: "unknown", nullable, node }
}

const safeIntegerBound = Number.MAX_SAFE_INTEGER

/** JSON Schema rules of a leaf that Env does not keep, as phrases such as "minimum length 1". */
export function constraintNotes(leaf: Leaf & { node: JsonObject }): string[] {
  const node = leaf.node
  const notes: string[] = []
  if (typeof node.format === "string") notes.push(`the ${node.format === "uri" || node.format === "url" ? "URL" : node.format} format`)
  if (typeof node.pattern === "string") notes.push(`the pattern ${node.pattern}`)
  if (typeof node.minLength === "number") notes.push(`minimum length ${node.minLength}`)
  if (typeof node.maxLength === "number") notes.push(`maximum length ${node.maxLength}`)
  if (leaf.kind === "integer") notes.push("the integer rule")
  if (typeof node.minimum === "number" && Math.abs(node.minimum) !== safeIntegerBound) notes.push(`minimum ${node.minimum}`)
  if (typeof node.maximum === "number" && Math.abs(node.maximum) !== safeIntegerBound) notes.push(`maximum ${node.maximum}`)
  if (typeof node.exclusiveMinimum === "number") notes.push(`exclusive minimum ${node.exclusiveMinimum}`)
  if (typeof node.exclusiveMaximum === "number") notes.push(`exclusive maximum ${node.exclusiveMaximum}`)
  if (typeof node.multipleOf === "number") notes.push(`multiple of ${node.multipleOf}`)
  for (const keyword of ["allOf", "not", "if", "dependentRequired", "dependentSchemas"]) {
    if (keyword in node) notes.push(`the JSON Schema ${keyword} rule`)
  }
  return notes
}

/** Converts a literal to the field kind, or returns `undefined` when it does not fit. */
export function coerceDefault(value: LiteralValue, field: Pick<EnvField, "kind" | "values">): LiteralValue | undefined {
  if (field.kind === "number") {
    if (typeof value === "number") return value
    const parsed = typeof value === "string" && value.trim() ? Number(value) : Number.NaN
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (field.kind === "boolean") {
    if (typeof value === "boolean") return value
    if (value === "true" || value === "1" || value === 1) return true
    if (value === "false" || value === "0" || value === 0) return false
    return undefined
  }
  const text = String(value)
  if (field.kind === "enum") return field.values?.includes(text) ? text : undefined
  return text
}

function literalText(value: NonNullable<EnvField["default"]>): string {
  return typeof value === "string" || typeof value === "object" ? JSON.stringify(value) : String(value)
}

const valibotJsonInputs = new Set([
  "array", "bigint", "boolean", "loose_object", "loose_tuple", "number", "object", "object_with_rest", "record", "strict_object",
  "strict_tuple", "tuple", "tuple_with_rest",
])

function valibotInputType(schema: unknown): string | undefined {
  let current = schema
  while (isRecord(current) && isRecord(current.wrapped)) current = current.wrapped
  return isValibotSchema(schema) && isRecord(current) && typeof current.type === "string" ? current.type : undefined
}

function plainFieldKind(leaf: Leaf): EnvFieldKind | undefined {
  if (leaf.kind === "integer") return "number"
  return leaf.kind === "boolean" || leaf.kind === "enum" || leaf.kind === "number" || leaf.kind === "string" ? leaf.kind : undefined
}

function schemaFieldKind(access: FieldAccess, leaf: Leaf): EnvFieldKind | undefined {
  const valibot = valibotInputType(access.schema)
  if (valibot === "string") return "string"
  if (valibot && valibotJsonInputs.has(valibot)) return "json"
  if (valibot && !["enum", "literal", "picklist"].includes(valibot)) return undefined
  if (leaf.kind === "string" || leaf.kind === "enum") return "string"
  return leaf.kind === "union" || leaf.kind === "unknown" ? undefined : "json"
}

function schemaDefault(value: LiteralValue, kind: EnvFieldKind): LiteralValue {
  return kind === "json" ? value : String(value)
}

function coerceRuntimeInput(value: LiteralValue, leaf: Leaf): LiteralValue {
  const kind = leaf.kind === "integer" ? "number" : leaf.kind
  if (kind === "array" || kind === "object" || kind === "union" || kind === "unknown") return value
  const normalized = typeof value === "string" && kind === "boolean" ? value.trim().toLowerCase() : value
  if ((kind === "string" || kind === "enum") && typeof value === "number" && !Number.isSafeInteger(value)) return value
  const coerced = coerceDefault(normalized, { kind, values: leaf.values })
  if (coerced === undefined || (leaf.kind === "integer" && !Number.isInteger(coerced))) return value
  return coerced
}

function leafAtPath(jsonSchema: JsonObject, path: readonly string[]): Leaf {
  let node = resolveReference(jsonSchema, jsonSchema)
  for (const key of path) {
    const properties = describeLeaf(jsonSchema, node).node.properties
    node = isRecord(properties) ? resolveReference(jsonSchema, properties[key]) : {}
  }
  return describeLeaf(jsonSchema, node)
}

/** Plans Env declarations from the JSON Schema of `runtimeConfig` and the values in nuxt.config. */
export async function planFromJsonSchema(input: PlanInput): Promise<SchemaPlan> {
  const root = resolveReference(input.jsonSchema, input.jsonSchema)
  const properties = root.properties
  if (root.type !== "object" || !isRecord(properties)) {
    throw codemodError("The $schema must describe the runtimeConfig object, for example `v.object({ ... })`.")
  }
  const plan: SchemaPlan = { fields: [], unmigrated: [], followUps: [], needsSchemaModule: false }
  const framework = input.framework ?? "nuxt"
  const frameworkName = framework === "nitro" ? "Nitro" : "Nuxt"
  const follow = (message: string, anchor?: PlannedFollowUp["anchor"]) => plan.followUps.push({ message, anchor })

  for (const issue of input.issues.get("") ?? []) {
    follow(`The $schema has ${issue} on the whole runtimeConfig, such as a cross-field rule. Env does not run it. Check it in server code.`, { schema: "" })
  }

  const requiredOf = (node: JsonObject) => new Set(Array.isArray(node.required) ? node.required.filter(key => typeof key === "string") : [])
  const validateAtRuntime = input.validateAtRuntime ?? false
  const validateAtBuild = input.validateAtBuild ?? !validateAtRuntime
  const coercionSchema = validateAtRuntime && isValibotSchema(input.schema)
    ? Object.fromEntries(Object.entries(toJsonSchema(input.schema, { errorMode: "ignore", typeMode: "input" })))
    : undefined

  const visit = async (section: EnvField["section"], configPath: string[], node: unknown, required: boolean): Promise<void> => {
    const label = pathLabel({ section, configPath })
    const schemaPath = section === "public" ? ["public", ...configPath] : configPath
    const runtimeValue = input.runtimeConfig.get(label)
    const leaf = describeLeaf(input.jsonSchema, isRecord(node) ? node : {})
    const objectProperties = leaf.node.properties
    if (leaf.kind === "object" && isRecord(objectProperties) && Object.keys(objectProperties).length) {
      const childRequired = requiredOf(leaf.node)
      if (!required) follow(`${label} is an optional group. Its Env fields are optional too.`, { schema: label })
      for (const issue of input.issues.get(label) ?? []) {
        follow(`${label} has ${issue}, such as a cross-field rule. Env does not run it. Check it in server code.`, { schema: label })
      }
      for (const [key, child] of Object.entries(objectProperties)) {
        await visit(section, [...configPath, key], child, required && childRequired.has(key))
      }
      return
    }
    const issues = input.issues.get(label) ?? []
    const constraints = [...constraintNotes(leaf), ...issues]
    const structured = leaf.kind === "array" || leaf.kind === "object"
    if (constraints.length || structured) plan.needsSchemaModule = true
    const exported = input.schemaExports && (constraints.length || structured) ? fieldAccess(input.schema, schemaPath) : undefined
    const publicFunction = section === "public" && typeof exported?.schema === "function"
    const found = publicFunction ? undefined : exported
    const schemaKind = found && schemaFieldKind(found, leaf)
    const access = schemaKind ? found : undefined
    const kind = schemaKind || plainFieldKind(leaf)
    const credential = looksSecret(configPath)
    const variable = nuxtVariableName(section, configPath, framework)
    const stay = (reason: string) => {
      plan.unmigrated.push(label)
      follow(`${label} ${reason} It stays in runtimeConfig. Read it with useRuntimeConfig(), or move it to Env by hand.`, { runtimeConfig: label })
    }
    const configValue = runtimeValue?.json
    if (kind && ((kind === "json" && leaf.kind === "object") || isRecord(configValue))) {
      const warning = credential ? " Remove any hardcoded credentials before deploying." : ""
      stay(`can receive nested overrides such as ${variable}_*, but one Env declaration reads only the whole value.${warning}`)
      return
    }
    const moduleInput = runtimeValue?.literal ?? runtimeValue?.processEnv?.fallback
    const jsonDefault = kind === "json" ? configValue : undefined
    if (kind && access && isAsyncSchema(access.schema, [undefined, moduleInput ?? jsonDefault])) {
      stay("has an async validator, and Env runs schemas synchronously.")
      return
    }
    if (kind && runtimeValue?.expression && jsonDefault === undefined) {
      const value = credential ? "a computed credential value" : `the value ${runtimeValue.expression}`
      stay(`has ${value} in runtimeConfig, which the codemod cannot keep as an Env default. Use ${variable} for the Env declaration.`)
      return
    }
    if (kind && access && moduleInput === undefined && jsonDefault === undefined && hasSchemaDefault(access.schema)) {
      stay("gets its default from its $schema, and Env does not run the schema when the variable is not set.")
      return
    }
    if (!kind) {
      plan.unmigrated.push(label)
      const reason = leaf.kind === "union"
        ? "is a union of input types, which the codemod cannot map to one Env declaration"
        : leaf.kind === "unknown"
          ? "has no JSON Schema type"
          : `is a JSON ${leaf.kind}, and the codemod cannot export its schema`
      const detail = issues.length ? ` It has ${issues.join(", ")}.` : ""
      follow(`${label} ${reason}.${detail} It stays in runtimeConfig without validation. Read it with useRuntimeConfig(), or ${section === "server" ? "export its schema from a server module and declare it with env.schemaFrom()" : "declare it with env.json() and its schema object, with mode: 'build'"}.`, { runtimeConfig: label })
      return
    }
    const field: EnvField = {
      section,
      configPath,
      envPath: section === "public" ? [flatPublicName(configPath)] : configPath,
      variable,
      kind,
      ...(kind === "enum" && leaf.kind === "enum" ? { values: leaf.values } : {}),
      required: required && !leaf.nullable,
      secret: section === "server" && kind !== "enum" && credential,
      ...(access ? { schema: { steps: access.steps } } : {}),
    }
    if (section === "server" && kind === "enum" && credential) {
      follow(`${label} looks like a credential, but an enum cannot be a secret because its values are public metadata. Use a string if the value is secret.`, { env: field })
    }
    if (section === "public" && credential) {
      follow(`${label} looks like a credential. Public Env is bundled into client code. Move it to the server section if it is secret.`, { env: field })
    }
    if (leaf.nullable) follow(`${label} accepts null. Env has no null value, so the field is optional and is undefined when the variable is not set.`, { env: field })
    if (section === "public" && configPath.length > 1) {
      follow(`${label} is nested. Public Env is flat, so read it as usePublicEnv().${field.envPath[0]}.`, { env: field })
    }
    if (kind === "json" && leaf.kind === "boolean") {
      follow(`${label}: Env reads ${field.variable} as JSON before its schema runs. Set it to true or false. Spellings such as 1, 0, or TRUE now fail.`, { env: field })
    }
    else if (kind === "json" && (leaf.kind === "number" || leaf.kind === "integer")) {
      follow(`${label}: Env reads ${field.variable} as JSON before its schema runs. Set it to a JSON number, such as 3000. Spellings such as 0xBB8, +3000, or .5 now fail.`, { env: field })
    }
    if (access && section === "server" && validateAtBuild && !validateAtRuntime) {
      follow(`${label}: the module ran its $schema only during the build (validateAtRuntime: false). Env runs it when the server reads ${field.variable}, so a value that the build did not check now stops the request.`, { env: field })
    }

    const runtimeInput = moduleInput !== undefined && validateAtRuntime
      ? coerceRuntimeInput(moduleInput, coercionSchema ? leafAtPath(coercionSchema, schemaPath) : leaf)
      : moduleInput
    const toDefault = (value: LiteralValue) => access ? schemaDefault(value, kind) : coerceDefault(value, field)
    let defaultValue: EnvField["default"] = jsonDefault ?? (runtimeInput === undefined ? undefined : toDefault(runtimeInput))
    if (runtimeValue?.literal !== undefined) {
      if (defaultValue === undefined) {
        const value = credential ? "a credential value" : `the value ${literalText(runtimeValue.literal)}`
        follow(`runtimeConfig.${label} has ${value}, which is not a valid ${kind}. It was not kept as a default.${credential ? ` Set ${variable} instead.` : ""}`, { env: field })
      }
    }
    else if (runtimeValue?.processEnv) {
      field.extraVariables = [runtimeValue.processEnv.name]
      follow(`runtimeConfig.${label} read process.env.${runtimeValue.processEnv.name} when ${frameworkName} loaded the config. Env now reads ${field.variable === runtimeValue.processEnv.name ? field.variable : `${field.variable}, then ${runtimeValue.processEnv.name}`}, ${section === "public" ? "during the build" : "when the server runs"}. Env treats an empty variable as unset.`, { env: field })
    }
    if (defaultValue === undefined && !access) {
      const schemaDefaultValue = leaf.node.default
      if (typeof schemaDefaultValue === "string" || typeof schemaDefaultValue === "number" || typeof schemaDefaultValue === "boolean") {
        defaultValue = toDefault(schemaDefaultValue)
      }
    }
    let rejection: string | undefined
    if (defaultValue !== undefined && input.rejectInvalidDefaults !== false && (validateAtRuntime || validateAtBuild)) {
      const schema = access?.schema ?? fieldSchema(input.schema, schemaPath)
      const check = { schema, node: leaf.node, input: jsonDefault ?? (validateAtBuild ? moduleInput : runtimeInput), value: defaultValue }
      rejection = await defaultRejection(check)
      if (rejection === undefined && validateAtBuild && jsonDefault === undefined && runtimeInput !== moduleInput) {
        rejection = await defaultRejection({ ...check, input: runtimeInput })
      }
    }
    if (defaultValue !== undefined && rejection !== undefined) {
      const value = credential ? "a credential default, which its $schema rejects" : `the value ${literalText(defaultValue)}, which its $schema rejects: ${rejection}`
      follow(`${label} had ${value}. The module treats this validation failure as fatal, so the codemod kept no default and Env requires ${field.variable}.`, { env: field })
      field.required = true
      defaultValue = undefined
    }
    if (defaultValue !== undefined && defaultValue !== "" && field.secret) {
      follow(`${label} is secret, so its value was not kept as a default. Defaults are written into the server build. Set ${field.variable} instead.`, { env: field })
      defaultValue = undefined
    }
    if (defaultValue !== undefined) field.default = defaultValue

    if (constraints.length && !access && publicFunction) {
      follow(`${label}: the codemod does not move a public schema that is a function, such as an ArkType type, and did not keep ${constraints.join(", ")}. Check the value in code.`, { env: field })
    }
    else if (constraints.length && !access) {
      const advice = section === "server" ? "Export the field schema from a server module and declare it with env.schemaFrom()" : "Pass the field schema object as the schema option"
      follow(`${label}: the codemod did not keep ${constraints.join(", ")}. ${advice}, or check the value in code.`, { env: field })
    }
    plan.fields.push(field)
  }

  const rootRequired = requiredOf(root)
  for (const [key, node] of Object.entries(properties)) {
    if (key === "public" && framework === "nuxt") {
      const publicNode = describeLeaf(input.jsonSchema, isRecord(node) ? node : {})
      const publicProperties = publicNode.node.properties
      if (!isRecord(publicProperties)) {
        plan.unmigrated.push("public")
        follow("public has no object shape in the $schema. It stays in runtimeConfig.", { runtimeConfig: "public" })
        continue
      }
      const publicRequired = requiredOf(publicNode.node)
      for (const [publicKey, child] of Object.entries(publicProperties)) {
        await visit("public", [publicKey], child, rootRequired.has("public") && publicRequired.has(publicKey))
      }
      continue
    }
    if (key === "app" || key === "nitro") {
      plan.unmigrated.push(key)
      follow(`${key} is a reserved ${frameworkName} runtimeConfig key. The codemod left it and its schema rules alone.`, { runtimeConfig: key })
      continue
    }
    await visit("server", [key], node, rootRequired.has(key))
  }
  const publicPaths = new Map<string, EnvField[]>()
  for (const field of plan.fields.filter(field => field.section === "public")) {
    const name = field.envPath[0]!
    publicPaths.set(name, [...(publicPaths.get(name) ?? []), field])
  }
  const collisions = new Set([...publicPaths.values()].filter(fields => fields.length > 1).flat())
  plan.fields = plan.fields.filter(field => !collisions.has(field))
  plan.followUps = plan.followUps.filter(entry => !(entry.anchor && "env" in entry.anchor && collisions.has(entry.anchor.env)))
  for (const field of collisions) {
    const label = pathLabel(field)
    plan.unmigrated.push(label)
    follow(`${label} collides with another public field at Public Env.${field.envPath[0]}. It stays in runtimeConfig. Choose distinct Env names and migrate these fields by hand.`, { runtimeConfig: label })
  }
  return plan
}
