import type { EnvSource, EnvSourceResolver, EnvVariableDeclaration, EnvVariableOptions } from "../types.ts"

interface DefaultStringSchema {
  __vitehubDefaultRuntimeSchema: string
  safeParse: (input: unknown) => { data: string, success: true } | { error: Error, success: false }
}

const defaultStringSchema: DefaultStringSchema = {
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

export const envSource = {
  custom(label: string, resolver: EnvSourceResolver): EnvSource {
    return {
      kind: "custom",
      label,
      resolver,
      serializable: false,
    }
  },
  env(name: string): EnvSource {
    return {
      kind: "env",
      label: `env:${name}`,
      name,
      serializable: true,
    }
  },
  gitBranch(): EnvSource {
    return {
      kind: "git-branch",
      label: "git:branch",
      serializable: true,
    }
  },
  gitCommit(options: { short?: boolean } = {}): EnvSource {
    return {
      kind: "git-commit",
      label: "git:commit",
      serializable: true,
      short: options.short,
    }
  },
  packageJson(path: string): EnvSource {
    return {
      kind: "package-json",
      label: `package.json:${path}`,
      path,
      serializable: true,
    }
  },
}

export function envVariable(options: EnvVariableOptions = {}): EnvVariableDeclaration {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("envVariable() only accepts a single options object.")
  }
  if (options.optional && typeof options.required !== "undefined") {
    throw new TypeError("envVariable() cannot use both optional and required.")
  }

  const required = options.optional ? false : options.required ?? true

  const source = typeof options.source === "function"
    ? envSource.custom("custom", options.source)
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

export function isDefaultStringEnvVariable(declaration: EnvVariableDeclaration): boolean {
  return defaultStringSchemas.get(declaration) === declaration.schema
    || (
      (declaration as unknown as Record<string, unknown>)[defaultStringSchemaProperty] === defaultStringSchemaToken
      && typeof declaration.schema === "object"
      && declaration.schema !== null
      && (declaration.schema as Record<string, unknown>)[defaultStringSchemaProperty] === defaultStringSchemaToken
      && hasDefaultStringSchemaParser(declaration.schema)
    )
}

function getDefaultStringSchemaToken(): string {
  const tokenKey = Symbol.for("vitehub.env.defaultRuntimeSchemaToken")
  const globalScope = globalThis as typeof globalThis & Record<symbol, string | undefined>
  globalScope[tokenKey] ??= `string:${Math.random().toString(36).slice(2)}`
  return globalScope[tokenKey]
}

function hasDefaultStringSchemaParser(schema: object): boolean {
  const candidate = schema as { safeParse?: unknown }
  return typeof candidate.safeParse === "function"
    && defaultStringSchemaParsers.has(candidate.safeParse as DefaultStringSchema["safeParse"])
}
