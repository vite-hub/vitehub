import type { EnvSource, EnvSourceResolver, EnvVariableDeclaration, EnvVariableOptions } from "../types.ts"

interface DefaultStringSchema {
  __vitehubDefaultStringSchema: true
  safeParse: (input: unknown) => { data: string, success: true } | { error: Error, success: false }
}

const defaultStringSchema: DefaultStringSchema = {
  __vitehubDefaultStringSchema: true,
  safeParse(input: unknown): { data: string, success: true } | { error: Error, success: false } {
    return typeof input === "string"
      ? { data: input, success: true as const }
      : { error: new Error("Expected string"), success: false as const }
  },
}

export function isDefaultStringSchema(schema: unknown): schema is DefaultStringSchema {
  return typeof schema === "object"
    && schema !== null
    && "__vitehubDefaultStringSchema" in schema
    && schema.__vitehubDefaultStringSchema === true
}

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

  return {
    default: options.default,
    kind: "env-variable",
    mode: options.mode ?? "runtime",
    required,
    schema: options.schema ?? defaultStringSchema,
    secret: options.secret ?? false,
    source,
    type: options.type,
  }
}
