export type EnvDiagnostics = "off" | "summary" | "trace"
export type EnvMode = "build" | "runtime"

export interface EnvIntegrationOptions {
  diagnostics?: EnvDiagnostics
  prefix?: string
}

export interface EnvSourceContext {
  env: Record<string, string | undefined>
  git: {
    branch: () => Promise<string>
    commit: (options?: { short?: boolean }) => Promise<string>
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
    kind: "package-json"
    label: string
    path: string
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

export interface EnvViteConfigOptions {
  define?: Record<string, EnvVariableDeclaration>
  public?: Record<string, EnvVariableDeclaration>
}

type EnvNitroConfigValue = EnvNitroConfigOptions | EnvVariableDeclaration

export interface EnvNitroConfigOptions {
  [key: string]: EnvNitroConfigValue
}

export type EnvConfigOptions = EnvViteConfigOptions | EnvNitroConfigOptions

export interface EnvViteUserConfig {
  env?: EnvViteConfigOptions
}

export interface EnvNitroUserConfig {
  env?: EnvNitroConfigOptions
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

export interface EnvRegistryEntry {
  default?: unknown
  required: boolean
  schema?: EnvRuntimeSchema
  secret: boolean
  source: Extract<EnvSource, { kind: "env" }>
  type?: string
}

export interface EnvRuntimeSchema {
  kind: "string"
}

export type EnvRuntimeRegistryValue = EnvRegistryEntry | EnvRuntimeRegistry

export interface EnvRuntimeRegistry {
  [key: string]: EnvRuntimeRegistryValue
}

export type SafeRuntimeConfig = Record<string, unknown>

export interface SafeBuildConfig {
  public: Record<string, unknown>
}
