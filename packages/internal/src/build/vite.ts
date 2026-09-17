import { statSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, parse, resolve } from "node:path"

type NoExternalValue = string | true | RegExp | (string | RegExp)[] | undefined
type WatchIgnoredMatcher = string | RegExp | ((testString: string, ...args: unknown[]) => boolean)
type WatchIgnoredValue = WatchIgnoredMatcher | WatchIgnoredMatcher[] | undefined

export interface ViteHubProviderImportContributor {
  vitehub?: {
    providerOutput?: {
      getImportAliases?: () => Promise<Record<string, string>> | Record<string, string>
    }
  }
}

export async function collectViteHubProviderImportAliases(
  plugins: ViteHubProviderImportContributor[],
): Promise<Record<string, string>> {
  return Object.assign({}, ...await Promise.all(plugins.map(async plugin =>
    await plugin.vitehub?.providerOutput?.getImportAliases?.() ?? {},
  )))
}

const generatedViteHubFilesPattern = "**/.vitehub/**"
const projectRootDirectoryMarkers = [
  ["server", "agents"],
  ["server", "channels"],
  ["server", "browsers"],
  ["server", "emails"],
  ["server", "schedules"],
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

export const VITEHUB_NITRO_RUNTIME_VERSION = "__vitehubNitroRuntimeVersion" as const
export const VITEHUB_NITRO_CONFIG_CONTEXT = "__vitehubNitroConfigContext" as const
export const VITEHUB_GENERATED_ROOT = "__vitehubGeneratedRoot" as const
export const VITEHUB_PROJECT_ROOT = "__vitehubProjectRoot" as const
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

/** The adapter selects the runtime; native Nitro Vite integrations use Nitro 3. */
export function nitroRuntimeVersion(config: { [VITEHUB_NITRO_RUNTIME_VERSION]?: 2 | 3, plugins?: unknown }): 2 | 3 {
  return config[VITEHUB_NITRO_RUNTIME_VERSION] ?? 3
}

/** Read Nuxt's actual version, since installed Nitro packages can belong to other hosts. */
export function nuxtNitroRuntimeVersion(version: string): 2 | 3 {
  const major = Number(version.split(".")[0])
  if (major === 3 || major === 4) return 2
  if (major === 5) return 3
  throw new Error(`[vitehub] Unsupported Nuxt version for Nitro runtime selection: ${version}`)
}

export function nitroRuntimeImports(version: 2 | 3 = 3): { plugin: string, middleware: string, cache: string } {
  return version === 2
    ? {
        plugin: "import { defineNitroPlugin as definePlugin } from 'nitropack/runtime'",
        middleware: "import { defineEventHandler as defineMiddleware } from 'h3'",
        cache: "import { cachedEventHandler as defineCachedHandler } from 'nitropack/runtime'",
      }
    : {
        plugin: "import { definePlugin } from 'nitro'",
        middleware: "import { defineMiddleware } from 'nitro'",
        cache: "import { defineCachedHandler } from 'nitro/cache'",
      }
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
  const temporaryRoot = resolve(tmpdir())
  const sharedTemporaryRoot = dirname(temporaryRoot) === parse(temporaryRoot).root ? temporaryRoot : undefined
  if (options.projectRoot) return resolve(resolvedRoot, options.projectRoot)

  if (basename(resolvedRoot) === "app") {
    const parent = dirname(resolvedRoot)
    if (parent !== sharedTemporaryRoot && hasProjectRootDirectoryMarker(parent)) return parent
  }

  let current = resolvedRoot
  while (true) {
    if (current === sharedTemporaryRoot && resolvedRoot !== current) return resolvedRoot
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
