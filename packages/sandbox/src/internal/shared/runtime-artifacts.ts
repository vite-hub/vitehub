import type { CloudflareSandboxEntrypointOptions } from '../../cloudflare'

export type ServerImport = {
  name: string
  from: string
  as?: string
  type?: boolean
  meta?: Record<string, unknown>
}

export interface FeatureManifest {
  alias: string
  aliasPath: string
  imports?: ServerImport[]
  typeTemplate?: {
    filename: string
    contents: string
  }
}

export interface GeneratedArtifact {
  key: string
  filename: string
  contents?: string
  getContents?: (artifacts: ReadonlyMap<string, EmittedArtifact>) => string | Promise<string>
}

export interface EmittedArtifact extends GeneratedArtifact {
  contents: string
  dst: string
  stableDst: string
}

export interface FeatureAliasRegistration {
  key: string
  value?: string
  artifactKey?: string
}

export interface FeatureHandlerRegistration {
  route: string
  method?: string
  handler?: string
  artifactKey?: string
}

export interface FeatureRuntimePlan {
  manifest: FeatureManifest
  aliases?: FeatureAliasRegistration[]
  artifacts?: GeneratedArtifact[]
  handlers?: FeatureHandlerRegistration[]
  cloudflare?: CloudflareSandboxEntrypointOptions
}
