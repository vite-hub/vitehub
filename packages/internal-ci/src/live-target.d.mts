export type LiveTargetDefinition = {
  appName: string
  buildEnvPlaceholders: Record<string, string>
  framework: string
  packageDir: string
  packageName: string
  provider: string
}

export type LiveDeployManifest = LiveTargetDefinition & {
  deployConfigPath?: string
  deployDir: string
  deployMode: "cloudflare-wrangler" | "vercel-prebuilt"
  linkedProjectPath?: string
  liveUrlTemplate?: string
  manifestPath: string
  queueNames?: string[]
  requiredBuildEnvNames: string[]
  requiredDeployEnvNames: string[]
  requiredRuntimeEnvNames: string[]
}

export type LiveTargetContext = {
  appPrefix: string
  buildEnvPlaceholders?: Record<string, string>
  packageDir: string
  packageName: string
  providers?: string[]
  workspaceDir: string
}

export function discoverFrameworks(packageDir: string, workspaceDir: string): string[]

export function getLiveTargetDefinitions(context: LiveTargetContext): LiveTargetDefinition[]

export function writeManifest(playgroundDir: string, provider: string, manifest: Record<string, unknown>): string

export function buildDefinitionForTarget(options: {
  appPrefix: string
  buildEnvPlaceholders?: Record<string, string>
  framework: string
  packageDir: string
  packageName: string
  provider: string
}): LiveTargetDefinition

export function prepareVercelManifest(options: {
  definition: LiveTargetDefinition
  playgroundDir: string
  workspaceDir: string
}): { manifest: LiveDeployManifest, manifestPath: string }

export function finalizeManifest(options: {
  manifest: LiveDeployManifest
  manifestPath: string
  workspaceDir: string
}): LiveDeployManifest
