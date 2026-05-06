import type { EnvSource, EnvSourceResolver, EnvVariableDeclaration, EnvVariableOptions } from "../types.ts"

interface DefaultStringSchema {
  __vitehubDefaultRuntimeSchema: string
  safeParse: (input: unknown) => { data: string, success: true } | { error: Error, success: false }
}

export const defaultStringSchema: DefaultStringSchema = {
  __vitehubDefaultRuntimeSchema: getDefaultStringSchemaToken(),
  safeParse(input: unknown): { data: string, success: true } | { error: Error, success: false } {
    return typeof input === "string"
      ? { data: input, success: true as const }
      : { error: new Error("Expected string"), success: false as const }
  },
}

const defaultStringSchemaProperty = "__vitehubDefaultRuntimeSchema"
const defaultStringSchemaToken = defaultStringSchema.__vitehubDefaultRuntimeSchema
const defaultStringSchemas = new WeakMap<EnvVariableDeclaration, DefaultStringSchema>()
const defaultStringSchemaParsers = new WeakSet<DefaultStringSchema["safeParse"]>()
defaultStringSchemaParsers.add(defaultStringSchema.safeParse)

interface EnvNamespace {
  (options?: EnvVariableOptions): EnvVariableDeclaration
  custom: (label: string, resolver: EnvSourceResolver) => EnvSource
  gitBranch: () => EnvSource
  gitCommit: (options?: { short?: boolean }) => EnvSource
  packageJson: (path: string) => EnvSource
  source: (name: string) => EnvSource
  variable: (options?: EnvVariableOptions) => EnvVariableDeclaration
}

function source(name: string): EnvSource {
  return {
    kind: "env",
    label: `env:${name}`,
    name,
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

function packageJson(path: string): EnvSource {
  return {
    kind: "package-json",
    label: `package.json:${path}`,
    path,
    serializable: true,
  }
}

function variable(options: EnvVariableOptions = {}): EnvVariableDeclaration {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("env() only accepts a single options object.")
  }
  if (options.optional && typeof options.required !== "undefined") {
    throw new TypeError("env() cannot use both optional and required.")
  }

  const required = options.optional ? false : options.required ?? true

  const source = typeof options.source === "function"
    ? custom("custom", options.source)
    : options.source

  const schema = options.schema ?? defaultStringSchema
  const declaration: EnvVariableDeclaration = {
    default: options.default,
    kind: "env-variable",
    mode: options.mode ?? "runtime",
    required,
    schema,
    secret: options.secret ?? false,
    source,
    type: options.type,
  }

  if (typeof options.schema === "undefined") {
    defaultStringSchemas.set(declaration, defaultStringSchema)
    Object.defineProperty(declaration, defaultStringSchemaProperty, {
      enumerable: true,
      value: defaultStringSchemaToken,
    })
  }

  return declaration
}

export const env: EnvNamespace = Object.assign(variable, {
  custom: custom,
  gitBranch: gitBranch,
  gitCommit: gitCommit,
  packageJson: packageJson,
  source: source,
  variable: variable,
})

export function isDefaultStringEnvVariable(declaration: EnvVariableDeclaration): boolean {
  return defaultStringSchemas.get(declaration) === declaration.schema
    || (
      (declaration as unknown as Record<string, unknown>)[defaultStringSchemaProperty] === defaultStringSchemaToken
      && typeof declaration.schema === "object"
      && declaration.schema !== null
      && (declaration.schema as Record<string, unknown>)[defaultStringSchemaProperty] === defaultStringSchemaToken
      && hasOnlyDefaultStringSchemaKeys(declaration.schema)
    )
}

function getDefaultStringSchemaToken(): string {
  const tokenKey = Symbol.for("vitehub.env.defaultRuntimeSchemaToken")
  const globalScope = globalThis as typeof globalThis & Record<symbol, string | undefined>
  globalScope[tokenKey] ??= `string:${Math.random().toString(36).slice(2)}`
  return globalScope[tokenKey]
}

function hasOnlyDefaultStringSchemaKeys(schema: object): boolean {
  if ("~standard" in schema || "parse" in schema) {
    return false
  }
  const keys = Reflect.ownKeys(schema)
  const safeParse = Object.getOwnPropertyDescriptor(schema, "safeParse")
  return keys.length === 2
    && keys.includes(defaultStringSchemaProperty)
    && keys.includes("safeParse")
    && typeof safeParse?.value === "function"
    && defaultStringSchemaParsers.has(safeParse.value as DefaultStringSchema["safeParse"])
}
