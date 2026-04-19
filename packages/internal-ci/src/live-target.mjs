import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

const defaultProviders = ["cloudflare", "vercel"]

export function discoverFrameworks(packageDir, workspaceDir) {
  const playgroundDir = join(workspaceDir, packageDir, "playground")
  if (!existsSync(playgroundDir))
    return []
  return readdirSync(playgroundDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith("."))
    .map(entry => entry.name)
    .sort()
}

function createDefinition({ appPrefix, buildEnvPlaceholders, framework, packageDir, packageName, provider }) {
  return {
    appName: `${appPrefix}-${framework}`,
    buildEnvPlaceholders: provider === "vercel" ? { ...buildEnvPlaceholders } : {},
    framework,
    packageDir,
    packageName,
    provider,
  }
}

export function getLiveTargetDefinitions({ appPrefix, buildEnvPlaceholders = {}, packageDir, packageName, providers = defaultProviders, workspaceDir }) {
  return discoverFrameworks(packageDir, workspaceDir).flatMap(framework =>
    providers.map(provider => createDefinition({ appPrefix, buildEnvPlaceholders, framework, packageDir, packageName, provider })),
  )
}

export function writeManifest(playgroundDir, provider, manifest) {
  const manifestDir = join(playgroundDir, ".vitehub")
  mkdirSync(manifestDir, { recursive: true })
  const manifestPath = join(manifestDir, `live-target.${provider}.json`)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifestPath
}

export function buildDefinitionForTarget({ appPrefix, buildEnvPlaceholders = {}, framework, packageDir, packageName, provider }) {
  return createDefinition({ appPrefix, buildEnvPlaceholders, framework, packageDir, packageName, provider })
}

export function prepareVercelManifest({ definition, playgroundDir, workspaceDir }) {
  const linkedProjectPath = join(playgroundDir, ".vercel", "project.json")
  const manifest = {
    ...definition,
    deployDir: relative(workspaceDir, playgroundDir),
    deployMode: "vercel-prebuilt",
    linkedProjectPath: relative(workspaceDir, linkedProjectPath),
    requiredBuildEnvNames: Object.keys(definition.buildEnvPlaceholders),
    requiredDeployEnvNames: ["VERCEL_TOKEN"],
    requiredRuntimeEnvNames: [],
  }
  return { manifest, manifestPath: writeManifest(playgroundDir, "vercel", manifest) }
}

export function finalizeManifest({ manifest, manifestPath, workspaceDir }) {
  return { ...manifest, manifestPath: relative(workspaceDir, manifestPath) }
}
