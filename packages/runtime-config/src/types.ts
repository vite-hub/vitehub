export type RuntimeConfigDiagnostics = "off" | "summary" | "trace"

export interface RuntimeConfigIntegrationOptions {
  diagnostics?: RuntimeConfigDiagnostics
}

export interface RuntimeConfigOptions {
  build?: {
    define?: Record<string, RuntimeConfigBuildDeclaration>
    public?: Record<string, RuntimeConfigBuildDeclaration>
  }
  runtime?: {
    cloudflare?: {
      bindings?: Record<string, RuntimeConfigBindingDeclaration>
      secrets?: Record<string, RuntimeConfigRuntimeDeclaration>
      vars?: Record<string, RuntimeConfigRuntimeDeclaration>
    }
    public?: Record<string, RuntimeConfigRuntimeDeclaration>
    server?: Record<string, RuntimeConfigRuntimeDeclaration>
  }
}

export interface ViteHubRuntimeConfigUserConfig {
  runtimeConfig?: RuntimeConfigOptions
}

export interface RuntimeConfigDeclarationOptions {
  default?: unknown
  description?: string
  type?: string
}

export interface RuntimeConfigBuildEnvDeclaration {
  default?: unknown
  envName: string
  kind: "build-env"
  schema: unknown
  type?: string
}

export interface RuntimeConfigRuntimeEnvDeclaration {
  default?: unknown
  envName: string
  kind: "runtime-env" | "runtime-secret"
  schema: unknown
  type?: string
}

export interface RuntimeConfigPackageValueDeclaration {
  key: string
  kind: "package-value"
  schema: unknown
  type?: string
}

export interface RuntimeConfigLiteralDefineDeclaration {
  kind: "define-literal"
  schema: unknown
  type?: string
  value: unknown
}

export type RuntimeConfigBuildDeclaration =
  | RuntimeConfigBuildEnvDeclaration
  | RuntimeConfigLiteralDefineDeclaration
  | RuntimeConfigPackageValueDeclaration

export type RuntimeConfigRuntimeDeclaration = RuntimeConfigRuntimeEnvDeclaration

export interface RuntimeConfigBindingDeclaration {
  bindingName: string
  bindingType: "ai" | "d1" | "durable-object" | "kv" | "queue" | "r2" | "service" | "vectorize" | "workflow" | "unknown"
  kind: "cloudflare-binding"
  type?: string
}

export interface RuntimeConfigDiagnosticEntry {
  exposed: string
  key: string
  masked: boolean
  source: string
  status: "available" | "defaulted" | "missing" | "valid"
  timing: string
  type?: string
}

export interface ResolvedRuntimeConfigEntry {
  key: string
  masked: boolean
  source: string
  type: string
  value: unknown
}

export interface RuntimeConfigRegistry {
  cloudflare?: {
    bindings?: Record<string, RuntimeConfigBindingDeclaration>
    secrets?: Record<string, RuntimeConfigRuntimeDeclaration>
    vars?: Record<string, RuntimeConfigRuntimeDeclaration>
  }
  public?: Record<string, RuntimeConfigRuntimeDeclaration>
  server?: Record<string, RuntimeConfigRuntimeDeclaration>
}

export interface RuntimeConfigResult {
  public: Record<string, unknown>
  server: Record<string, unknown>
}

export interface CloudflareRuntimeConfigResult {
  bindings: Record<string, unknown>
  secrets: Record<string, unknown>
  vars: Record<string, unknown>
}
