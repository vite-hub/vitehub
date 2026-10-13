import type { EnvManagement } from "./http.ts"
import type { EnvAccessContext } from "./bridge.ts"
import type { SecretEnv } from "./secret.ts"

export type EnvDiagnostics = "off" | "summary" | "trace"
export type EnvMode = "build" | "runtime"

export interface EnvIntegrationOptions {
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
    branch: () => Promise<string>
    commit: (options?: { short?: boolean }) => Promise<string>
    ref: () => Promise<string>
    sha: (options?: { short?: boolean }) => Promise<string>
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
    kind: "git-ref"
    label: "git:ref"
    serializable: true
  }
  | {
    kind: "git-sha"
    label: "git:sha"
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

export interface EnvVariableOptions {
  default?: unknown
  mode?: EnvMode
  optional?: boolean
  required?: boolean
  schema?: unknown
  secret?: boolean
  source?: EnvSource | EnvSourceResolver
  type?: string
}

/** Options for `env.boolean()`, `env.number()`, and `env.enum()`. The helper owns the parser and type. */
export interface EnvTypedVariableOptions<TValue> extends Omit<EnvVariableOptions, "default" | "schema" | "type"> {
  default?: TValue
}

/** Serializable parser for one Server Env value. Host and provider values are strings before parsing. */
export type EnvValueSchema =
  | { kind: "boolean" }
  | { kind: "enum", values: readonly string[] }
  | { kind: "number" }
  | { kind: "string" }

export type EnvBuildStaticValue = null | string | number | boolean | EnvBuildStaticValue[]

type EnvBuildConfigValue = EnvBuildConfigOptions | EnvBuildStaticValue | EnvVariableDeclaration

export interface EnvBuildConfigOptions {
  [key: string]: EnvBuildConfigValue
}

export interface EnvViteConfigOptions {
  define?: Record<string, EnvBuildConfigValue>
  public?: Record<string, EnvVariableDeclaration>
  server?: EnvRuntimeConfigOptions
}

export type EnvRuntimeStaticValue = null | string | number | boolean | EnvRuntimeStaticValue[]

type EnvRuntimeConfigValue = EnvRuntimeConfigOptions | EnvRuntimeStaticValue | EnvVariableDeclaration

export interface EnvRuntimeConfigOptions {
  [key: string]: EnvRuntimeConfigValue
}

export type EnvConfigOptions = EnvViteConfigOptions

export interface EnvViteUserConfig {
  env?: EnvViteConfigOptions
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

export interface ServerEnv {
  [key: string]: unknown
}
export type PublicEnv = Record<string, unknown>

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
