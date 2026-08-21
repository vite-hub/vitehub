import { statSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

type NoExternalValue = string | true | RegExp | (string | RegExp)[] | undefined
type WatchIgnoredMatcher = string | RegExp | ((testString: string, ...args: unknown[]) => boolean)
type WatchIgnoredValue = WatchIgnoredMatcher | WatchIgnoredMatcher[] | undefined

const generatedViteHubFilesPattern = "**/.vitehub/**"
const projectRootDirectoryMarkers = [
  ["server", "agents"],
  ["server", "channels"],
  ["server", "browsers"],
  ["server", "emails"],
  ["server", "schedules"],
  ["server", "templates"],
  ["server", "workspaces"],
]
const projectRootFileMarkers = [
  ["package.json"],
]

export const VITEHUB_ENV_PUBLIC_ID = "#vitehub/env/public" as const
export const VITEHUB_ENV_SERVER_ID = "#vitehub/env/server" as const

export function createNoExternalMerger(packageName: string) {
  return (current: NoExternalValue): NoExternalValue => {
    if (current === true) {
      return true
    }
    if (!current) {
      return [packageName]
    }
    const values = Array.isArray(current) ? current : [current]
    return values.includes(packageName) ? values : [...values, packageName]
  }
}

export function isServerEnvironment(name: string, config: { consumer?: string }): boolean {
  return name === "ssr" || config.consumer === "server"
}

interface NitroVercelConfig {
  environments?: Record<string, { build?: { outDir?: string } }>
  nitro?: { preset?: string }
  plugins?: unknown
}

export const VITEHUB_NITRO_CONFIG_CONTEXT = "__vitehubNitroConfigContext" as const
export const VITEHUB_GENERATED_ROOT = "__vitehubGeneratedRoot" as const
export const VITEHUB_SERVER_DIRS = "__vitehubServerDirs" as const

function includesNitroVitePlugin(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(includesNitroVitePlugin)
  if (!value || typeof value !== "object") return false
  return "name" in value && value.name === "nitro:main"
}

export function hasNitroConfigContext(config: {
  [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean
  plugins?: unknown
}): boolean {
  return config[VITEHUB_NITRO_CONFIG_CONTEXT] === true || includesNitroVitePlugin(config.plugins)
}

export function resolveNitroVercelFunctionName(
  config: NitroVercelConfig,
  product: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const preset = config.nitro?.preset || env.NITRO_PRESET || env.SERVER_PRESET
  const nitro = Boolean(preset) || hasNitroConfigContext(config)
  const clientOutDir = config.environments?.client?.build?.outDir
  const vercel = preset
    ? preset.startsWith("vercel")
    : env.VITEHUB_HOSTING === "vercel"
      || Boolean(env.VERCEL)
      || Boolean(clientOutDir && /(^|[/\\])\.vercel[/\\]output([/\\]|$)/.test(clientOutDir))
  return nitro && vercel
    ? `__${product}.func`
    : undefined
}

export function shouldSkipViteProviderBuild(command: "build" | "serve" | undefined, mode?: string): boolean {
  return command === "serve" || mode === "e2e"
}

export function mergeGeneratedViteHubWatchIgnored(ignored: WatchIgnoredValue): WatchIgnoredValue {
  if (!ignored) return [generatedViteHubFilesPattern]
  if (Array.isArray(ignored)) {
    return ignored.includes(generatedViteHubFilesPattern) ? ignored : [...ignored, generatedViteHubFilesPattern]
  }
  return [ignored, generatedViteHubFilesPattern]
}

export function resolveViteHubProjectRoot(root: string, options: { projectRoot?: string } = {}): string {
  const resolvedRoot = resolve(root)
  if (options.projectRoot) return resolve(resolvedRoot, options.projectRoot)

  if (basename(resolvedRoot) === "app") {
    const parent = dirname(resolvedRoot)
    if (hasProjectRootDirectoryMarker(parent)) return parent
  }

  let current = resolvedRoot
  while (true) {
    if (hasProjectRootMarker(current)) return current

    const parent = dirname(current)
    if (parent === current) return resolvedRoot
    current = parent
  }
}

export function resolveViteHubGeneratedRoot(config: {
  [VITEHUB_GENERATED_ROOT]?: string
  root?: string
}): string {
  return config[VITEHUB_GENERATED_ROOT]
    ? resolve(config[VITEHUB_GENERATED_ROOT])
    : resolve(config.root ?? process.cwd(), ".vitehub")
}

function hasProjectRootDirectoryMarker(root: string): boolean {
  for (const marker of projectRootDirectoryMarkers) {
    try {
      if (statSync(resolve(root, ...marker)).isDirectory()) return true
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return false
}

function hasProjectRootMarker(root: string): boolean {
  if (hasProjectRootDirectoryMarker(root)) return true
  for (const marker of projectRootFileMarkers) {
    try {
      if (statSync(resolve(root, ...marker)).isFile()) return true
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return false
}

export function viteHubEnvAmbientTypesPath(root: string): string {
  return resolve(root, ".vitehub", "types", "env.d.ts")
}

export function viteHubEnvPublicModulePath(root: string): string {
  return resolve(root, ".vitehub", "env", "public.mjs")
}

export function viteHubEnvPublicModuleTypesPath(root: string): string {
  return resolve(root, ".vitehub", "env", "public.d.ts")
}

export function viteHubEnvServerModulePath(root: string): string {
  return resolve(root, ".vitehub", "env", "server.mjs")
}

export function viteHubEnvServerModuleTypesPath(root: string): string {
  return resolve(root, ".vitehub", "env", "server.d.ts")
}

export function createViteHubEnvImportAliases(root: string): Record<string, string> {
  return {
    [VITEHUB_ENV_PUBLIC_ID]: viteHubEnvPublicModulePath(root),
    [VITEHUB_ENV_SERVER_ID]: viteHubEnvServerModulePath(root),
  }
}
