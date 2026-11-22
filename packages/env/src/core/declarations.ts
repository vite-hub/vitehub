import type { EnvMode, EnvSchemaModuleReference, EnvSource, EnvSourceResolver, EnvTypedVariableOptions, EnvValueSchema, EnvVariableDeclaration, EnvVariableOptions } from "../types.ts"
import { envErrorDiagnostics } from "../error-diagnostics.ts"
import { isRuntimeRecord } from "../internal/runtime-type.ts"
import { envValueTypeName, listItemKinds, parseEnvValue, readJsonInput, stringValueSchema } from "./values.ts"

type EnvListItem = boolean | number | string

interface StandardSchemaLike {
  "~standard": { validate: (value: unknown) => unknown }
}

type SafeParse = (input: unknown) => { data: unknown, success: true } | { error: Error, success: false }

interface RuntimeValueSchema {
  __vitehubRuntimeSchema: string
  safeParse: SafeParse
}

const runtimeSchemaProperty = "__vitehubRuntimeSchema"
const runtimeSchemaToken = getRuntimeSchemaToken()
const runtimeSchemaParsers = new WeakMap<CallableFunction, EnvValueSchema>()
const runtimeSchemas = new WeakMap<EnvVariableDeclaration, RuntimeValueSchema>()

function createRuntimeValueSchema(valueSchema: EnvValueSchema): RuntimeValueSchema {
  const safeParse: SafeParse = (input) => {
    const result = parseEnvValue(valueSchema, input)
    return result.success
      ? result
      : { error: envErrorDiagnostics.ENV_R0001({ message: result.message }), success: false }
  }
  runtimeSchemaParsers.set(safeParse, valueSchema)
  return { [runtimeSchemaProperty]: runtimeSchemaToken, safeParse }
}

export const defaultStringSchema: RuntimeValueSchema = createRuntimeValueSchema(stringValueSchema)
const booleanSchema = createRuntimeValueSchema(Object.freeze({ kind: "boolean" }))
const numberSchema = createRuntimeValueSchema(Object.freeze({ kind: "number" }))

interface EnvNamespace {
  (options?: EnvVariableOptions): EnvVariableDeclaration
  boolean: (options?: EnvTypedVariableOptions<boolean>) => EnvVariableDeclaration
  buildTimestamp: () => EnvSource
  custom: (label: string, resolver: EnvSourceResolver) => EnvSource
  enum: <const TValues extends readonly [string, ...string[]]>(values: TValues, options?: EnvTypedVariableOptions<TValues[number]> & { secret?: never }) => EnvVariableDeclaration
  gitBranch: () => EnvSource
  gitCommit: (options?: { short?: boolean }) => EnvSource
  gitTag: () => EnvSource
  json: {
    (options?: EnvTypedVariableOptions<unknown>): EnvVariableDeclaration
    (schema: EnvSchemaModuleReference | StandardSchemaLike, options?: EnvTypedVariableOptions<unknown>): EnvVariableDeclaration
  }
  list: {
    (options?: EnvTypedVariableOptions<readonly EnvListItem[]>): EnvVariableDeclaration
    (item: EnvVariableDeclaration, options?: EnvTypedVariableOptions<readonly EnvListItem[]>): EnvVariableDeclaration
  }
  number: (options?: EnvTypedVariableOptions<number>) => EnvVariableDeclaration
  packageJson: (path: string) => EnvSource
  provider: (provider: string, key: string) => EnvSource
  schemaFrom: (module: string, exportName?: string) => EnvSchemaModuleReference
  source: (name: string | string[], options?: { canonical?: boolean }) => EnvSource
}

function source(name: string | string[], options: { canonical?: boolean } = {}): EnvSource {
  const names = Array.isArray(name) ? name : [name]
  if (!names.length || names.some(value => typeof value !== "string" || !value.trim())) {
    throw envErrorDiagnostics.ENV_R0002({ message: "env.source() requires one or more non-empty env variable names." })
  }
  const normalized = names.map(value => value.trim())
  return {
    kind: "env",
    label: `env:${normalized.join("|")}`,
    name: normalized[0]!,
    ...(options.canonical === false ? { canonical: false as const } : {}),
    ...(normalized.length > 1 ? { names: normalized } : {}),
    serializable: true,
  }
}

function custom(label: string, resolver: EnvSourceResolver): EnvSource {
  return {
    kind: "custom",
    label,
    resolver,
    serializable: false,
  }
}

function gitBranch(): EnvSource {
  return {
    kind: "git-branch",
    label: "git:branch",
    serializable: true,
  }
}

function gitCommit(options: { short?: boolean } = {}): EnvSource {
  return {
    kind: "git-commit",
    label: "git:commit",
    serializable: true,
    short: options.short,
  }
}

function gitTag(): EnvSource {
  return {
    kind: "git-tag",
    label: "git:tag",
    serializable: true,
  }
}

function buildTimestamp(): EnvSource {
  return {
    kind: "build-timestamp",
    label: "build:timestamp",
    serializable: true,
  }
}

function packageJson(path: string): EnvSource {
  return {
    kind: "package-json",
    label: `package.json:${path}`,
    path,
    serializable: true,
  }
}

function provider(provider: string, key: string): EnvSource {
  if (typeof provider !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(provider.trim())) {
    throw envErrorDiagnostics.ENV_R0003({ message: "env.provider() requires a provider name that starts with a letter and contains only letters, numbers, underscores, or hyphens." })
  }
  if (typeof key !== "string" || !key.trim() || key.length > 512) {
    throw envErrorDiagnostics.ENV_R0004({ message: "env.provider() requires a non-empty provider key." })
  }
  return {
    key: key.trim(),
    kind: "provider",
    label: "provider",
    provider: provider.trim(),
    serializable: true,
  }
}

function schemaFrom(module: string, exportName = "default"): EnvSchemaModuleReference {
  if (typeof module !== "string" || !module.trim()) {
    throw envErrorDiagnostics.ENV_R0029({ message: "env.schemaFrom() requires a non-empty module specifier." })
  }
  if (typeof exportName !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportName)) {
    throw envErrorDiagnostics.ENV_R0029({ message: "env.schemaFrom() requires an export name that is a JavaScript identifier." })
  }
  return Object.freeze({ kind: "schema-module", module: module.trim(), export: exportName })
}

/** Return the module reference of a declaration whose schema comes from `env.schemaFrom()`. */
export function schemaModuleReference(schema: unknown): EnvSchemaModuleReference | undefined {
  try {
    if (!isRuntimeRecord(schema) || schema.kind !== "schema-module") return undefined
    return typeof schema.module === "string" && typeof schema.export === "string"
      ? { kind: "schema-module", module: schema.module, export: schema.export, ...(schema.input === "json" ? { input: "json" as const } : {}) }
      : undefined
  }
  catch {
    return undefined
  }
}

function variable(options: EnvVariableOptions = {}): EnvVariableDeclaration {
  const snapshot = readDeclarationOptions(options)
  return createDeclaration(snapshot, snapshot.schema ?? defaultStringSchema, snapshot.type)
}

function typedVariable(schema: RuntimeValueSchema, options: EnvVariableOptions): EnvVariableDeclaration {
  const snapshot = readDeclarationOptions(options)
  const valueSchema = runtimeSchemaParsers.get(schema.safeParse)
  return createDeclaration(snapshot, schema, valueSchema && envValueTypeName(valueSchema))
}

/** Create an internal built-in declaration whose parser survives runtime serialization. */
export function descriptorVariable(valueSchema: EnvValueSchema, options: EnvTypedVariableOptions<unknown>): EnvVariableDeclaration {
  return typedVariable(createRuntimeValueSchema(valueSchema), options)
}

function booleanVariable(options: EnvTypedVariableOptions<boolean> = {}): EnvVariableDeclaration {
  return typedVariable(booleanSchema, options)
}

function numberVariable(options: EnvTypedVariableOptions<number> = {}): EnvVariableDeclaration {
  return typedVariable(numberSchema, options)
}

function enumVariable<const TValues extends readonly [string, ...string[]]>(
  values: TValues,
  options: EnvTypedVariableOptions<TValues[number]> & { secret?: never } = {},
): EnvVariableDeclaration {
  if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== "string" || !value) || new Set(values).size !== values.length) {
    throw envErrorDiagnostics.ENV_R0022({ message: "env.enum() requires one or more unique non-empty strings." })
  }
  return typedVariable(createRuntimeValueSchema(Object.freeze({ kind: "enum", values: Object.freeze([...values]) })), options)
}

function listVariable(
  itemOrOptions?: EnvVariableDeclaration | EnvTypedVariableOptions<readonly EnvListItem[]>,
  options?: EnvTypedVariableOptions<readonly EnvListItem[]>,
): EnvVariableDeclaration {
  if (!isDeclaration(itemOrOptions)) {
    if (options !== undefined) {
      throw envErrorDiagnostics.ENV_LIST_ITEM_INVALID({ message: "env.list() takes the item parser first, for example env.list(env.number(), { default: [1] })." })
    }
    return typedVariable(createRuntimeValueSchema(Object.freeze({ kind: "list" })), itemOrOptions ?? {})
  }
  const items = runtimeValueSchema(itemOrOptions)
  if (!items || !listItemKinds.has(items.kind) || itemOrOptions.source !== undefined || itemOrOptions.default !== undefined || itemOrOptions.secret || !itemOrOptions.required || itemOrOptions.mode !== "runtime") {
    throw envErrorDiagnostics.ENV_LIST_ITEM_INVALID({ message: "env.list() takes an item parser without options: env(), env.boolean(), env.number(), or env.enum([...]). Put the options on the list, for example env.list(env.number(), { default: [1] })." })
  }
  return typedVariable(createRuntimeValueSchema(Object.freeze({ items, kind: "list" })), options ?? {})
}

function jsonVariable(
  schemaOrOptions?: EnvSchemaModuleReference | StandardSchemaLike | EnvTypedVariableOptions<unknown>,
  options?: EnvTypedVariableOptions<unknown>,
): EnvVariableDeclaration {
  const reference = schemaModuleReference(schemaOrOptions)
  if (reference) {
    return createDeclaration(readDeclarationOptions(options ?? {}), Object.freeze({ ...reference, input: "json" as const }), undefined)
  }
  if (isStandardSchemaLike(schemaOrOptions)) {
    const snapshot = readDeclarationOptions(options ?? {})
    if (snapshot.mode !== "build") {
      throw envErrorDiagnostics.ENV_JSON_SCHEMA_INVALID({ message: "env.json() in env.server runs in the server build, so it cannot take a schema object from the config. Export the schema from a module and pass env.schemaFrom(), for example env.json(env.schemaFrom('./server/env.schema.ts', 'settings')). A schema object works only with mode: 'build'." })
    }
    return createDeclaration(snapshot, jsonStandardSchema(schemaOrOptions), undefined)
  }
  if (isSchemaModule(schemaOrOptions) || options !== undefined || isRuntimeRecord(schemaOrOptions) && ("kind" in schemaOrOptions || "~standard" in schemaOrOptions)) {
    throw envErrorDiagnostics.ENV_JSON_SCHEMA_INVALID({ message: "env.json() takes env.schemaFrom(), a Standard Schema, or only options." })
  }
  return typedVariable(createRuntimeValueSchema(Object.freeze({ kind: "json" })), schemaOrOptions ?? {})
}

function jsonStandardSchema(schema: StandardSchemaLike): StandardSchemaLike {
  const validate = schema["~standard"].validate
  return {
    "~standard": {
      validate: (value: unknown) => {
        const json = readJsonInput(value)
        return json.success ? validate(json.data) : { issues: [{ message: json.message }] }
      },
    },
  }
}

function isSchemaModule(value: unknown): value is EnvSchemaModuleReference {
  return schemaModuleReference(value) !== undefined
}

function isStandardSchemaLike(value: unknown): value is StandardSchemaLike {
  try {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return false
    const standard: unknown = Reflect.get(value, "~standard")
    return isRuntimeRecord(standard) && typeof standard.validate === "function"
  }
  catch {
    return false
  }
}

function isDeclaration(value: unknown): value is EnvVariableDeclaration {
  try {
    return isRuntimeRecord(value) && value.kind === "env-variable"
  }
  catch {
    return false
  }
}

interface DeclarationOptions {
  default: unknown
  mode: EnvMode | undefined
  optional: boolean
  schema: unknown
  secret: boolean | undefined
  source: EnvSource | EnvSourceResolver | undefined
  type: string | undefined
}

const declarationOptionKeys: ReadonlySet<string> = new Set(["default", "mode", "optional", "schema", "secret", "source", "type"])

function copyOptions(options: EnvVariableOptions): EnvVariableOptions | undefined {
  if (!isRuntimeRecord(options)) return undefined
  return Object.fromEntries(Object.getOwnPropertyNames(options).map(key => [key, options[key]]))
}

function readDeclarationOptions(options: EnvVariableOptions): DeclarationOptions {
  let snapshot: EnvVariableOptions | undefined
  try {
    snapshot = copyOptions(options)
  }
  catch (cause) {
    throw envErrorDiagnostics.ENV_R0005({ message: "env() only accepts a single options object.", cause })
  }
  if (!snapshot) {
    throw envErrorDiagnostics.ENV_R0005({ message: "env() only accepts a single options object." })
  }
  for (const key of Object.keys(snapshot)) {
    if (key === "required") {
      throw envErrorDiagnostics.ENV_R0006({ message: "env() does not accept required. A value is required by default. Use optional: true for a value that can be missing." })
    }
    if (!declarationOptionKeys.has(key)) {
      throw envErrorDiagnostics.ENV_R0005({ message: `env() does not accept ${key}. Use default, mode, optional, schema, secret, source, or type.` })
    }
  }
  if (snapshot.optional === true && snapshot.default !== undefined) {
    throw envErrorDiagnostics.ENV_R0006({ message: "env() cannot use both optional and default. A default makes the value always present." })
  }
  return {
    default: snapshot.default,
    mode: snapshot.mode,
    optional: snapshot.optional === true,
    schema: snapshot.schema,
    secret: snapshot.secret,
    source: snapshot.source,
    type: snapshot.type,
  }
}

function createDeclaration(options: DeclarationOptions, schema: unknown, type: string | undefined): EnvVariableDeclaration {
  const required = !options.optional

  const source = typeof options.source === "function"
    ? custom("custom", options.source)
    : options.source

  const declaration: EnvVariableDeclaration = {
    default: options.default,
    kind: "env-variable",
    mode: options.mode ?? "runtime",
    required,
    schema,
    secret: options.secret ?? false,
    source,
    type,
  }

  if (isRuntimeValueSchema(schema)) {
    runtimeSchemas.set(declaration, schema)
    Object.defineProperty(declaration, runtimeSchemaProperty, {
      enumerable: true,
      value: runtimeSchemaToken,
    })
  }

  return declaration
}

export const env: EnvNamespace = Object.assign(variable, {
  boolean: booleanVariable,
  buildTimestamp: buildTimestamp,
  custom: custom,
  enum: enumVariable,
  gitBranch: gitBranch,
  gitCommit: gitCommit,
  gitTag: gitTag,
  json: jsonVariable,
  list: listVariable,
  number: numberVariable,
  packageJson: packageJson,
  provider: provider,
  schemaFrom: schemaFrom,
  source: source,
})

/** Return the serializable value schema of a declaration created by `env()`, `env.boolean()`, `env.number()`, or `env.enum()`. */
export function runtimeValueSchema(declaration: EnvVariableDeclaration): EnvValueSchema | undefined {
  const schema = declaration.schema
  if (runtimeSchemas.get(declaration) === schema && isRuntimeValueSchema(schema)) {
    return runtimeSchemaParsers.get(schema.safeParse)
  }
  const declarationToken = Object.getOwnPropertyDescriptor(declaration, runtimeSchemaProperty)?.value
  if (declarationToken !== runtimeSchemaToken || !isRuntimeRecord(schema)) return undefined
  const schemaToken = Object.getOwnPropertyDescriptor(schema, runtimeSchemaProperty)?.value
  if (schemaToken !== runtimeSchemaToken || !hasOnlyRuntimeSchemaKeys(schema)) return undefined
  const safeParse = Object.getOwnPropertyDescriptor(schema, "safeParse")?.value
  return typeof safeParse === "function" ? runtimeSchemaParsers.get(safeParse) : undefined
}

function isRuntimeValueSchema(schema: unknown): schema is RuntimeValueSchema {
  try {
    return isRuntimeRecord(schema) && typeof schema.safeParse === "function" && runtimeSchemaParsers.has(schema.safeParse)
  }
  catch {
    return false
  }
}

function getRuntimeSchemaToken(): string {
  const tokenKey = Symbol.for("vitehub.env.runtimeSchemaToken")
  const globalScope = globalThis as typeof globalThis & Record<symbol, string | undefined>
  globalScope[tokenKey] ??= `schema:${Math.random().toString(36).slice(2)}`
  return globalScope[tokenKey]
}

function hasOnlyRuntimeSchemaKeys(schema: Record<PropertyKey, unknown>): boolean {
  if ("~standard" in schema || "parse" in schema) {
    return false
  }
  const keys = Reflect.ownKeys(schema)
  const safeParse = Object.getOwnPropertyDescriptor(schema, "safeParse")
  return keys.length === 2
    && keys.includes(runtimeSchemaProperty)
    && keys.includes("safeParse")
    && typeof safeParse?.value === "function"
}
