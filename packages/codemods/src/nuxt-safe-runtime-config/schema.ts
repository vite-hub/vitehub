import { toJsonSchema } from "@valibot/to-json-schema"

import { CodemodError } from "../types.ts"
import { flatPublicName, looksSecret, nuxtVariableName, pathLabel } from "./fields.ts"

import type { BaseIssue, BaseSchema } from "valibot"
import type { EnvField, LiteralValue, PlannedFollowUp } from "./fields.ts"
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

/** Converts a Standard Schema to the JSON Schema of its input, the shape that host values must have. */
export async function schemaToJsonSchema(schema: unknown): Promise<JsonObject> {
  const standard = isRecord(schema) ? schema["~standard"] : undefined
  if (!isRecord(schema) || !isRecord(standard)) {
    throw new CodemodError("The $schema is not a Standard Schema. Use a Valibot, Zod, or ArkType schema.")
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
  throw new CodemodError(`Cannot convert the ${vendor} $schema to JSON Schema${nativeError ? `: ${errorText(nativeError)}` : ""}. Zod 4.2 or newer, Valibot 1, and ArkType 2 are supported.`)
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

function addIssue(issues: Map<string, string[]>, path: readonly string[], issue: string): void {
  const key = path.join(".")
  issues.set(key, [...(issues.get(key) ?? []), issue])
}

function valibotIssues(schema: unknown, path: string[], issues: Map<string, string[]>): void {
  if (!isRecord(schema)) return
  if (Array.isArray(schema.pipe)) {
    for (const action of schema.pipe.slice(1)) {
      if (!isRecord(action) || typeof action.type !== "string") continue
      if (action.kind === "transformation") addIssue(issues, path, `the Valibot ${action.type} action`)
      else if (action.kind === "validation" && !valibotJsonValidations.has(action.type)) addIssue(issues, path, `the Valibot ${action.type} check`)
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

function zodIssues(schema: unknown, path: string[], issues: Map<string, string[]>): void {
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

/** Rules that JSON Schema cannot hold, such as transforms and custom checks, by dotted path. `""` is the schema root. */
export function schemaIssues(schema: unknown): Map<string, string[]> {
  const issues = new Map<string, string[]>()
  if (isValibotSchema(schema)) valibotIssues(schema, [], issues)
  else if (zodDefinition(schema)) zodIssues(schema, [], issues)
  return issues
}

export interface SchemaPlan {
  fields: EnvField[]
  /** Labels of `runtimeConfig` paths that stay in `runtimeConfig`, such as `public.tags`. */
  unmigrated: string[]
  followUps: PlannedFollowUp[]
}

interface PlanInput {
  jsonSchema: JsonObject
  issues: Map<string, string[]>
  runtimeConfig: Map<string, RuntimeConfigValue>
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

function describeLeaf(root: JsonObject, input: JsonObject): Leaf & { node: JsonObject } {
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

function constraintNotes(leaf: Leaf & { node: JsonObject }): string[] {
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

function coerceDefault(value: LiteralValue, field: Pick<EnvField, "kind" | "values">): LiteralValue | undefined {
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

function literalText(value: LiteralValue): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value)
}

/** Plans Env declarations from the JSON Schema of `runtimeConfig` and the values in nuxt.config. */
export function planFromJsonSchema(input: PlanInput): SchemaPlan {
  const root = resolveReference(input.jsonSchema, input.jsonSchema)
  const properties = root.properties
  if (root.type !== "object" || !isRecord(properties)) {
    throw new CodemodError("The $schema must describe the runtimeConfig object, for example `v.object({ ... })`.")
  }
  const plan: SchemaPlan = { fields: [], unmigrated: [], followUps: [] }
  const follow = (message: string, anchor?: PlannedFollowUp["anchor"]) => plan.followUps.push({ message, anchor })

  for (const issue of input.issues.get("") ?? []) {
    follow(`The $schema has ${issue} on the whole runtimeConfig, such as a cross-field rule. Env does not run it. Check it in server code.`, { schema: "" })
  }

  const requiredOf = (node: JsonObject) => new Set(Array.isArray(node.required) ? node.required.filter(key => typeof key === "string") : [])

  const visit = (section: EnvField["section"], configPath: string[], node: unknown, required: boolean): void => {
    const label = pathLabel({ section, configPath })
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
        visit(section, [...configPath, key], child, required && childRequired.has(key))
      }
      return
    }
    if (leaf.kind === "array" || leaf.kind === "object" || leaf.kind === "union" || leaf.kind === "unknown") {
      plan.unmigrated.push(label)
      const reason = leaf.kind === "union"
        ? "is a union, which Env cannot declare"
        : leaf.kind === "unknown"
          ? "has no JSON Schema type"
          : `is a JSON ${leaf.kind}, which code-first Env declarations cannot parse`
      const alternative = leaf.kind === "array" || leaf.kind === "object"
        ? `, or declare it in a .env.example with @type=${leaf.kind}(...) and use envSchema()`
        : ""
      follow(`${label} ${reason}. It stays in runtimeConfig without validation. Read it with useRuntimeConfig()${alternative}.`, { runtimeConfig: label })
      return
    }
    const kind = leaf.kind === "integer" ? "number" : leaf.kind
    if (runtimeValue?.processEnv?.operator === "||") {
      plan.unmigrated.push(label)
      follow(`runtimeConfig.${label} uses process.env.${runtimeValue.processEnv.name} || a fallback. It stays in runtimeConfig without validation to preserve the empty-string fallback. Migrate it by hand with an Env source that skips empty values.`, { runtimeConfig: label })
      return
    }
    const field: EnvField = {
      section,
      configPath,
      envPath: section === "public" ? [flatPublicName(configPath)] : configPath,
      variable: nuxtVariableName(section, configPath),
      kind,
      ...(leaf.kind === "enum" ? { values: leaf.values } : {}),
      required: required && !leaf.nullable,
      secret: section === "server" && kind !== "enum" && looksSecret(configPath),
    }
    if (section === "server" && kind === "enum" && looksSecret(configPath)) {
      follow(`${label} looks like a credential, but an enum cannot be a secret because its values are public metadata. Use a string if the value is secret.`, { env: field })
    }
    if (section === "public" && looksSecret(configPath)) {
      follow(`${label} looks like a credential. Public Env is bundled into client code. Move it to the server section if it is secret.`, { env: field })
    }
    if (leaf.nullable) follow(`${label} accepts null. Env has no null value, so the field is optional and is undefined when the variable is not set.`, { env: field })
    if (section === "public" && configPath.length > 1) {
      follow(`${label} is nested. Public Env is flat, so read it as usePublicEnv().${field.envPath[0]}.`, { env: field })
    }

    let defaultValue: LiteralValue | undefined
    if (runtimeValue?.literal !== undefined) {
      defaultValue = coerceDefault(runtimeValue.literal, field)
      if (defaultValue === undefined) {
        follow(`runtimeConfig.${label} has the value ${literalText(runtimeValue.literal)}, which is not a valid ${kind}. It was not kept as a default.`, { env: field })
      }
    }
    else if (runtimeValue?.processEnv) {
      field.extraVariables = [runtimeValue.processEnv.name]
      if (runtimeValue.processEnv.fallback !== undefined) {
        defaultValue = coerceDefault(runtimeValue.processEnv.fallback, field)
      }
      follow(`runtimeConfig.${label} read process.env.${runtimeValue.processEnv.name} when Nuxt loaded the config. Env now reads ${field.variable}, then ${runtimeValue.processEnv.name}, ${section === "public" ? "during the build" : "when the server runs"}.`, { env: field })
    }
    else if (runtimeValue?.expression) {
      follow(`runtimeConfig.${label} is computed (${runtimeValue.expression}). It was not kept as a default. Set ${field.variable} or add a default by hand.`, { env: field })
    }
    if (defaultValue === undefined) {
      const schemaDefault = leaf.node.default
      if (typeof schemaDefault === "string" || typeof schemaDefault === "number" || typeof schemaDefault === "boolean") {
        defaultValue = coerceDefault(schemaDefault, field)
      }
    }
    // An empty default preserves behavior without embedding a credential in the build.
    if (defaultValue !== undefined && defaultValue !== "" && field.secret) {
      follow(`${label} is secret, so its value ${literalText(defaultValue)} was not kept as a default. Defaults are written into the server build. Set ${field.variable} instead.`, { env: field })
      defaultValue = undefined
    }
    if (defaultValue !== undefined) field.default = defaultValue

    const constraints = [...constraintNotes(leaf), ...(input.issues.get(label) ?? [])]
    if (constraints.length) {
      follow(`${label}: Env does not keep ${constraints.join(", ")}. Check the value in code, or use envSchema() with a .env.example for length, range, integer, and URL checks.`, { env: field })
    }
    plan.fields.push(field)
  }

  const rootRequired = requiredOf(root)
  for (const [key, node] of Object.entries(properties)) {
    if (key === "public") {
      const publicNode = describeLeaf(input.jsonSchema, isRecord(node) ? node : {})
      const publicProperties = publicNode.node.properties
      if (!isRecord(publicProperties)) {
        plan.unmigrated.push("public")
        follow("public has no object shape in the $schema. It stays in runtimeConfig.", { runtimeConfig: "public" })
        continue
      }
      const publicRequired = requiredOf(publicNode.node)
      for (const [publicKey, child] of Object.entries(publicProperties)) {
        visit("public", [publicKey], child, rootRequired.has("public") && publicRequired.has(publicKey))
      }
      continue
    }
    if (key === "app" || key === "nitro") {
      plan.unmigrated.push(key)
      follow(`${key} is a reserved Nuxt runtimeConfig key. The codemod left it and its schema rules alone.`, { runtimeConfig: key })
      continue
    }
    visit("server", [key], node, rootRequired.has(key))
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
