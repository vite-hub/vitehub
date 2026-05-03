import type { EnvSource, EnvSourceResolver, EnvVariableDeclaration, EnvVariableOptions } from "../types.ts"

const stringSchema = {
  safeParse(input: unknown) {
    return typeof input === "string"
      ? { data: input, success: true as const }
      : { error: new Error("Expected string"), success: false as const }
  },
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

export function envVariable(name: string, options?: EnvVariableOptions): EnvVariableDeclaration
export function envVariable(options: EnvVariableOptions & { source: EnvSource | EnvSourceResolver }): EnvVariableDeclaration
export function envVariable(
  nameOrOptions: string | (EnvVariableOptions & { source: EnvSource | EnvSourceResolver }),
  maybeOptions?: EnvVariableOptions,
): EnvVariableDeclaration {
  const options = typeof nameOrOptions === "string" ? maybeOptions ?? {} : nameOrOptions
  if (options.optional && typeof options.required !== "undefined") {
    throw new TypeError("envVariable() cannot use both optional and required.")
  }

  const source = typeof nameOrOptions === "string"
    ? envSource.env(nameOrOptions)
    : normalizeSource(options.source as EnvSource | EnvSourceResolver)
  const required = options.optional ? false : options.required ?? true

  return {
    default: options.default,
    kind: "env-variable",
    mode: options.mode ?? "runtime",
    required,
    schema: options.schema ?? stringSchema,
    secret: options.secret ?? false,
    source,
    type: options.type,
  }
}

function normalizeSource(source: EnvSource | EnvSourceResolver): EnvSource {
  if (typeof source === "function") {
    return envSource.custom("custom", source)
  }
  return source
}
