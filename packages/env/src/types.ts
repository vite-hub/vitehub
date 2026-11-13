import type { EnvManagement } from "./http.ts"
import type { EnvAccessContext } from "./bridge.ts"
import type { SecretEnv } from "./secret.ts"

export type EnvDiagnostics = "off" | "summary" | "trace"
export type EnvMode = "build" | "runtime"

/** Options of `vitehub({ env })` and `hubEnv()`: the Env declarations and how ViteHub resolves them. */
export interface EnvOptions extends EnvDeclarations {
  diagnostics?: EnvDiagnostics
  /**
   * Prefix of canonical variable names. Every env-backed declaration first reads the prefix plus its
   * path in upper snake case, then its conventional names. Defaults to `"VITEHUB_"`. `false` disables it.
   */
  prefix?: string | false
  projectRoot?: string
  providers?: Record<string, string>
  runtimeImports?: EnvRuntimeImportSpecifiers
}

export interface EnvRuntimeImportSpecifiers {
  secret?: string
  server?: string
}

export interface EnvSourceContext {
  build: {
    timestamp: () => string
  }
  env: Record<string, string | undefined>
  git: {
    /** Reads `GIT_BRANCH`, then `GITHUB_HEAD_REF`, then `GITHUB_REF_NAME` on a GitHub branch ref, then local Git. */
    branch: () => Promise<string>
    /** Reads `GIT_SHA`, then `GITHUB_SHA`, then local Git. */
    commit: (options?: { short?: boolean }) => Promise<string>
    /** Reads `GIT_TAG`, then `GITHUB_REF_NAME` on a GitHub tag ref, then local Git. */
    tag: () => Promise<string | undefined>
  }
  mode: EnvMode
  packageJson: () => Promise<Record<string, unknown>>
  rootDir: string
}

export type EnvSourceResolver = (context: EnvSourceContext) => unknown | Promise<unknown>

export type EnvSource =
  | {
    kind: "custom"
    label: string
    resolver: EnvSourceResolver
    serializable: false
  }
  | {
    kind: "env"
    label: string
    name: string
    names?: string[]
    /** The canonical name, `VITEHUB_<PATH>`, which the ordered names read first. */
    canonical?: string | false
    /** Treat empty host values as missing when reading the ordered names. */
    skipEmpty?: boolean
    serializable: true
  }
  | {
    kind: "git-branch"
    label: "git:branch"
    serializable: true
  }
  | {
    kind: "git-commit"
    label: "git:commit"
    serializable: true
    short?: boolean
  }
  | {
    kind: "git-tag"
    label: "git:tag"
    serializable: true
  }
  | {
    kind: "build-timestamp"
    label: "build:timestamp"
    serializable: true
  }
  | {
    kind: "package-json"
    label: string
    path: string
    serializable: true
  }
  | {
    key: string
    kind: "provider"
    label: "provider"
    provider: string
    serializable: true
  }

export interface EnvVariableDeclaration {
  default?: unknown
  kind: "env-variable"
  mode: EnvMode
  required: boolean
  schema: unknown
  secret: boolean
  source?: EnvSource
  type?: string
}

interface EnvVariableBaseOptions {
  mode?: EnvMode
  schema?: unknown
  secret?: boolean
  source?: EnvSource | EnvSourceResolver
  type?: string
}

/**
 * A value is required by default. `optional: true` lets it be missing.
 * A `default` makes the value always present, so it cannot be combined with `optional: true`.
 */
export type EnvRequirednessOptions<TValue> =
  | { default?: TValue, optional?: false }
  | { default?: never, optional: true }

export type EnvVariableOptions = EnvVariableBaseOptions & EnvRequirednessOptions<unknown>

/** Options for `env.boolean()`, `env.number()`, and `env.enum()`. The helper owns the parser and type. */
export type EnvTypedVariableOptions<TValue> = Omit<EnvVariableBaseOptions, "schema" | "type"> & EnvRequirednessOptions<TValue>

/** Serializable parser for one Server Env value. Host and provider values are strings before parsing. */
export type EnvValueSchema =
  | { kind: "boolean" }
  | { kind: "enum", values: readonly string[] }
  | { kind: "number", min?: number, max?: number, isInt?: boolean, decimal?: boolean }
  | { kind: "string", minLength?: number, maxLength?: number }
  | { kind: "url" }
  | { kind: "array", items?: EnvValueSchema }
  | { kind: "object", properties?: Record<string, EnvValueSchema> }

/**
 * A Standard Schema that the server build imports from a module. Server Env runs it on the raw value when it resolves,
 * so refinements and transforms work. Create it with `env.schemaFrom()`.
 */
export interface EnvSchemaModuleReference {
  kind: "schema-module"
  /** Module specifier. A relative path resolves from the project root, like `hubEnv({ providers })`. */
  module: string
  /** Name of the export that holds the schema. */
  export: string
}

export type EnvBuildStaticValue = null | string | number | boolean | EnvBuildStaticValue[]

type EnvBuildConfigValue = EnvBuildConfigOptions | EnvBuildStaticValue | EnvVariableDeclaration

export interface EnvBuildConfigOptions {
  [key: string]: EnvBuildConfigValue
}

/** Declarations of Public Env, Server Env, and build-time replacements. */
export interface EnvDeclarations {
  /** Values that replace identifiers at build time. */
  define?: Record<string, EnvBuildConfigValue>
  /** Public Env, resolved at build time and readable in browser code. Each declaration uses `mode: "build"`. */
  public?: Record<string, EnvVariableDeclaration>
  /** Server Env, resolved at runtime and readable only in server code. */
  server?: EnvRuntimeConfigOptions
}

export type EnvRuntimeStaticValue = null | string | number | boolean | EnvRuntimeStaticValue[]

type EnvRuntimeConfigValue = EnvRuntimeConfigOptions | EnvRuntimeStaticValue | EnvVariableDeclaration

export interface EnvRuntimeConfigOptions {
  [key: string]: EnvRuntimeConfigValue
}


export interface EnvDiagnosticEntry {
  exposed: string
  key: string
  masked: boolean
  mode: EnvMode
  source: string
  status: "defaulted" | "missing" | "valid"
  timing: string
  type?: string
}

export interface ResolvedEnvEntry {
  key: string
  masked: boolean
  source: string
  type: string
  value: unknown
}

interface EnvRegistryEntry {
  default?: unknown
  required: boolean
  schema?: EnvValueSchema
  schemaModule?: EnvSchemaModuleReference
  secret: boolean
  source: Extract<EnvSource, { kind: "env" | "provider" }>
}

interface EnvRuntimeLiteralEntry {
  kind: "literal"
  value: EnvRuntimeStaticValue
}

export type EnvRuntimeRegistryValue = EnvRegistryEntry | EnvRuntimeLiteralEntry | EnvRuntimeRegistry

declare const serverEnvType: unique symbol

export interface EnvRuntimeRegistry<TServerEnv extends Record<string, unknown> = Record<string, unknown>> {
  [key: string]: EnvRuntimeRegistryValue
  readonly [serverEnvType]?: (value: TServerEnv) => void
}

/** Server Env. ViteHub generates its fields from the Env declarations into `.vitehub/types/`. */
export interface ServerEnv {}
/** Public Env. ViteHub generates its fields from the Env declarations into `.vitehub/types/`. */
export interface PublicEnv {}
export type ReadonlyServerEnv = DeepReadonly<ServerEnv>

export interface EnvProviderContext<TEnv extends Record<string, unknown> = Record<string, unknown>> {
  env: DeepReadonly<TEnv>
  access?: EnvAccessContext
  signal?: AbortSignal
}

export type EnvProviderValues = Readonly<Record<string, string | undefined>>

export interface EnvProvider<TEnv extends Record<string, unknown> = Record<string, unknown>> {
  management?: EnvManagement
  read(input: EnvProviderContext<TEnv> & { keys: readonly string[] }): EnvProviderValues | Promise<EnvProviderValues>
}

export type EnvProviders = Record<string, EnvProvider>

export interface LoadServerEnvOptions {
  access?: EnvAccessContext
  providers?: EnvProviders
  signal?: AbortSignal
}

export type DeepReadonly<T> = T extends SecretEnv<unknown>
  ? T
  : T extends (...args: infer TArguments) => infer TResult
  ? (...args: TArguments) => TResult
  : T extends object
    ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
    : T

export type ServerEnvInspectionStatus = "available" | "defaulted" | "error" | "invalid" | "missing"

export interface ServerEnvInspectionEntry {
  /** The declaration is secret. Inspection never returns values. */
  masked: boolean
  path?: string
  /** Provider alias for provider-backed declarations. */
  provider?: string
  required: boolean
  source: "env" | "literal" | "provider"
  status: ServerEnvInspectionStatus
  /** Which kind of variable name supplied an env value: the canonical `VITEHUB_<PATH>` name, or a conventional name. */
  via?: "canonical" | "conventional"
  /** The canonical name and a conventional name are both set to different values. The canonical name wins. */
  conflict?: true
}

export interface ServerEnvDescriptionEntry {
  path?: string
  /** The canonical variable name of an env declaration, such as `VITEHUB_CLIPROXY_API_KEY`. It is read first. */
  canonicalName?: string
  source: "env" | "literal" | "provider"
  provider?: string
  secret: boolean
  required: boolean
  hasDefault: boolean
  /** TypeScript type of the parsed value, for example `boolean` or `"draft" | "send"`. Omitted for literals. */
  type?: string
}

export interface ServerEnvDescription {
  entries: readonly ServerEnvDescriptionEntry[]
}

export interface ServerEnvInspection {
  entries: readonly ServerEnvInspectionEntry[]
}
