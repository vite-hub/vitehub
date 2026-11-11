import type { EnvSchemaModuleReference, EnvSource, EnvSourceResolver, EnvTypedVariableOptions, EnvValueSchema, EnvVariableDeclaration, EnvVariableOptions } from "../types.ts"
import { envErrorDiagnostics } from "../error-diagnostics.ts"
import { isRuntimeRecord } from "../internal/runtime-type.ts"
import { envValueTypeName, parseEnvValue, stringValueSchema } from "./values.ts"

type SafeParse = (input: unknown) => { data: unknown, success: true } | { error: Error, success: false }

interface RuntimeValueSchema {
  __vitehubRuntimeSchema: string
  safeParse: SafeParse
}

const runtimeSchemaProperty = "__vitehubRuntimeSchema"
const runtimeSchemaToken = getRuntimeSchemaToken()
// Vite and Nuxt clone config objects but keep function references, so parsers identify built-in schemas.
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
  /** Parse `true`, `false`, `1`, or `0` into a boolean. */
  boolean: (options?: EnvTypedVariableOptions<boolean>) => EnvVariableDeclaration
  buildTimestamp: () => EnvSource
  custom: (label: string, resolver: EnvSourceResolver) => EnvSource
  /** Accept only the listed strings. The values are public metadata, so an enum cannot be secret. */
  enum: <const TValues extends readonly [string, ...string[]]>(values: TValues, options?: Omit<EnvTypedVariableOptions<TValues[number]>, "secret">) => EnvVariableDeclaration
  gitBranch: () => EnvSource
  gitCommit: (options?: { short?: boolean }) => EnvSource
  gitRef: () => EnvSource
  gitSha: (options?: { short?: boolean }) => EnvSource
  gitTag: () => EnvSource
  /** Parse a finite number. */
  number: (options?: EnvTypedVariableOptions<number>) => EnvVariableDeclaration
  packageJson: (path: string) => EnvSource
  provider: (provider: string, key: string) => EnvSource
  /**
   * Validate a Server Env value with a Standard Schema exported by a module, for example `env.schemaFrom("./server/env.schema.ts", "apiUrl")`.
   * The server build imports the module, so refinements and transforms run on every resolution.
   */
  schemaFrom: (module: string, exportName?: string) => EnvSchemaModuleReference
  source: (name: string | string[], options?: { canonical?: boolean, skipEmpty?: boolean }) => EnvSource
  variable: (options?: EnvVariableOptions) => EnvVariableDeclaration
}

function source(name: string | string[], options: { canonical?: boolean, skipEmpty?: boolean } = {}): EnvSource {
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
    ...(options.skipEmpty ? { skipEmpty: true } : {}),
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

function gitRef(): EnvSource {
  return {
    kind: "git-ref",
    label: "git:ref",
    serializable: true,
  }
}

function gitSha(options: { short?: boolean } = {}): EnvSource {
  return {
    kind: "git-sha",
    label: "git:sha",
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
      ? { kind: "schema-module", module: schema.module, export: schema.export }
      : undefined
  }
  catch {
    return undefined
  }
}

function variable(options: EnvVariableOptions = {}): EnvVariableDeclaration {
  options = readDeclarationOptions(options)
  return createDeclaration(options, options.schema ?? defaultStringSchema, options.type)
}

function typedVariable(schema: RuntimeValueSchema, options: EnvVariableOptions): EnvVariableDeclaration {
  options = readDeclarationOptions(options)
  const valueSchema = runtimeSchemaParsers.get(schema.safeParse)
  return createDeclaration(options, schema, valueSchema && envValueTypeName(valueSchema))
}

/** Create an internal built-in declaration whose parser survives runtime serialization. */
export function descriptorVariable(valueSchema: EnvValueSchema, options: Omit<EnvVariableOptions, "schema" | "type">): EnvVariableDeclaration {
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
  options: Omit<EnvTypedVariableOptions<TValues[number]>, "secret"> = {},
): EnvVariableDeclaration {
  if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== "string" || !value) || new Set(values).size !== values.length) {
    throw envErrorDiagnostics.ENV_R0022({ message: "env.enum() requires one or more unique non-empty strings." })
  }
  return typedVariable(createRuntimeValueSchema(Object.freeze({ kind: "enum", values: Object.freeze([...values]) })), options)
}

function isInspectableRecord(value: unknown): boolean {
  try {
    if (!isRuntimeRecord(value)) return false
    Reflect.ownKeys(value)
    return true
  }
  catch {
    return false
  }
}

// Read options once so Proxy traps cannot bypass the declaration diagnostic.
function readDeclarationOptions(options: EnvVariableOptions): EnvVariableOptions {
  if (!isInspectableRecord(options)) {
    throw envErrorDiagnostics.ENV_R0005({ message: "env() only accepts a single options object." })
  }
  let snapshot: EnvVariableOptions
  try {
    snapshot = {
      default: options.default,
      mode: options.mode,
      optional: options.optional,
      required: options.required,
      schema: options.schema,
      secret: options.secret,
      source: options.source,
      type: options.type,
    }
  }
  catch {
    throw envErrorDiagnostics.ENV_R0005({ message: "env() only accepts a single options object." })
  }
  if (snapshot.optional && snapshot.required !== undefined) {
    throw envErrorDiagnostics.ENV_R0006({ message: "env() cannot use both optional and required." })
  }
  return snapshot
}

function createDeclaration(options: EnvVariableOptions, schema: unknown, type: string | undefined): EnvVariableDeclaration {
  const required = options.optional ? false : options.required ?? true

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
  gitRef: gitRef,
  gitSha: gitSha,
  gitTag: gitTag,
  number: numberVariable,
  packageJson: packageJson,
  provider: provider,
  schemaFrom: schemaFrom,
  source: source,
  variable: variable,
})

/** Return the serializable value schema of a declaration created by `env()`, `env.boolean()`, `env.number()`, or `env.enum()`. */
export function runtimeValueSchema(declaration: EnvVariableDeclaration): EnvValueSchema | undefined {
  const schema = declaration.schema
  if (runtimeSchemas.get(declaration) === schema && isRuntimeValueSchema(schema)) {
    return runtimeSchemaParsers.get(schema.safeParse)
  }
  // Cloned config reaches this path. Fail closed when reflection throws, for example on a revoked Proxy.
  try {
    const declarationToken = Object.getOwnPropertyDescriptor(declaration, runtimeSchemaProperty)?.value
    if (declarationToken !== runtimeSchemaToken || !isRuntimeRecord(schema)) return undefined
    const schemaToken = Object.getOwnPropertyDescriptor(schema, runtimeSchemaProperty)?.value
    if (schemaToken !== runtimeSchemaToken || !hasOnlyRuntimeSchemaKeys(schema)) return undefined
    const safeParse = Object.getOwnPropertyDescriptor(schema, "safeParse")?.value
    return typeof safeParse === "function" ? runtimeSchemaParsers.get(safeParse) : undefined
  }
  catch {
    return undefined
  }
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
