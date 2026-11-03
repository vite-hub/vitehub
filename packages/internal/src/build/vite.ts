import { statSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, parse, resolve } from "node:path"

import type { ConfigEnv, EnvironmentOptions } from "vite"

type NoExternalValue = string | true | RegExp | (string | RegExp)[] | undefined
type WatchIgnoredMatcher = string | RegExp | ((testString: string, ...args: unknown[]) => boolean)
type WatchIgnoredValue = WatchIgnoredMatcher | WatchIgnoredMatcher[] | undefined

export interface ViteHubProviderImportContributor {
  vitehub?: {
    providerOutput?: {
      getImportAliases?: () => Promise<Record<string, string>> | Record<string, string>
      prepareSources?: (sources: { resolve: (path: string) => string }) => Promise<void> | void
    }
  }
}

export async function prepareViteHubProviderSources(
  plugins: ViteHubProviderImportContributor[],
  sources: { resolve: (path: string) => string },
): Promise<void> {
  for (const plugin of plugins) await plugin.vitehub?.providerOutput?.prepareSources?.(sources)
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
  ["server", "connections"],
  ["server", "browsers"],
  ["server", "emails"],
  ["server", "schedules"],
  ["server", "workspaces"],
]
const projectRootFileMarkers = [
  ["package.json"],
  ["nuxt.config.ts"],
  ["nuxt.config.mts"],
  ["nuxt.config.js"],
  ["nuxt.config.mjs"],
]

export const VITEHUB_ENV_PUBLIC_ID = "#vitehub/env/public" as const
export const VITEHUB_ENV_SERVER_ID = "#vitehub/env/server" as const
export const VITEHUB_ENV_DESCRIPTION_ID = "#vitehub/env/description" as const

// Config hooks for existing ViteHub packages need the complete merged value,
// while newer hooks can return only additions for Vite's array merge behavior.
export function createNoExternalMerger(packageName: string) {
  return (current: NoExternalValue): NoExternalValue => {
    if (current === true) return true
    if (!current) return [packageName]
    const values = Array.isArray(current) ? current : [current]
    return values.includes(packageName) ? values : [...values, packageName]
  }
}

// Vite concatenates arrays when it merges a config hook result. Return only the missing entries.
export function createNoExternalAddition(...packageNames: string[]) {
  return (current: NoExternalValue): string[] | undefined => {
    if (current === true) return
    const values = Array.isArray(current) ? current : [current]
    const missing = packageNames.filter(packageName => !values.includes(packageName))
    return missing.length ? missing : undefined
  }
}

export function isServerEnvironment(name: string, config: { consumer?: string }): boolean {
  return name === "ssr" || config.consumer === "server"
}

/** Nitro RC externalizes dependencies by default; explicit inlining still needs CommonJS pre-bundling in workerd. */
export function workerdDependencyConfig(name: string, config: EnvironmentOptions, env: ConfigEnv): EnvironmentOptions | undefined {
  if (env.command !== "serve" || !isServerEnvironment(name, config) || config.resolve?.noExternal !== true) return
  if (!config.resolve.conditions?.some(condition => condition === "workerd" || condition === "worker")) return
  // Keep Nitro's route-bearing app out of the pre-bundle and respect an app's explicit discovery setting.
  return { optimizeDeps: { noDiscovery: config.optimizeDeps?.noDiscovery ?? false, exclude: ["nitro"] } }
}

export interface ProviderOutputEnvironmentOwner {
  /** Install as the plugin's `buildApp` hook. */
  buildApp: (builder: { environments: Record<string, { isBuilt: boolean }> }) => Promise<void>
  /** Install as the plugin's `nitro` module. */
  nitro: { name: string, setup: (nitro: { options: { static?: boolean } }) => void }
  /** Whether a later environment of the same Vite build writes Provider Output. */
  defers: (context: { environment?: object } | undefined) => boolean
}

/**
 * Lets a plugin write Provider Output once per Vite build. Nitro builds the `nitro` environment after
 * the client and SSR environments, so those earlier environments defer to it. A `vite build()` call
 * without `buildApp` or a static Nitro build has no later environment and does not defer.
 */
export function createProviderOutputEnvironmentOwner(name: string): ProviderOutputEnvironmentOwner {
  let builder: { environments: Record<string, { isBuilt: boolean }> } | undefined
  let nitroBuildsServer = false
  return {
    async buildApp(next) {
      builder = next
    },
    nitro: {
      name,
      setup(nitro) {
        nitroBuildsServer = !nitro.options.static
      },
    },
    defers(context) {
      const nitro = builder?.environments.nitro
      return Boolean(nitroBuildsServer && nitro && !nitro.isBuilt && context?.environment && context.environment !== nitro)
    },
  }
}

/**
 * Whether Node loads installed ViteHub packages directly in this environment, without Vite's SSR transform.
 * This is the Nitro environment of `vite dev`. Generated Nitro plugins give these packages the registries and the
 * `define` values that Vite gives to the code it transforms. Builds and other environments still inline the packages.
 */
export function loadsViteHubPackagesNatively(name: string, env: { command: string }): boolean {
  return env.command === "serve" && name === "nitro"
}

/** A generated module, and the package export that receives it when Node loads the package in `vite dev`. */
export interface NativePackageInstall {
  /** The generated module, such as `./registry.mjs`. Omit it to clear a previous installation. */
  module?: string
  /** The package entry that exports `install`. */
  from: string
  /** The export that receives the module namespace. */
  install: string
}

/**
 * Render a Nitro plugin for `vite dev` that hands generated modules to the packages that read them.
 * A package that Node loads resolves its `#vitehub/*` imports to its own fallback module, which keeps what the plugin
 * installs. The install runs when Nitro evaluates the plugin, so it runs again when a reload re-evaluates a module.
 */
export function renderNativePackageInstallPlugin(installs: readonly NativePackageInstall[]): string {
  return [
    ...installs.flatMap(({ from, install, module }, index) => [
      `import { ${install} as viteHubInstall${index} } from ${JSON.stringify(from)}`,
      ...(module ? [`import * as viteHubModule${index} from ${JSON.stringify(module)}`] : []),
    ]),
    "",
    ...installs.map(({ module }, index) => `viteHubInstall${index}(${module ? `viteHubModule${index}` : "undefined"})`),
    "",
    "export default function viteHubNativePackagesPlugin() {}",
    "",
  ].join("\n")
}

interface NitroVercelConfig {
  environments?: Record<string, { build?: { outDir?: string } }>
  nitro?: { preset?: string }
  plugins?: unknown
}

export const VITEHUB_NITRO_CONFIG_CONTEXT = "__vitehubNitroConfigContext" as const
/** Nitro used by the Nuxt host, independently of ViteHub's own Nitro dependency. */
export const VITEHUB_NITRO_MAJOR_VERSION = "__vitehubNitroMajorVersion" as const
export const VITEHUB_GENERATED_ROOT = "__vitehubGeneratedRoot" as const
export const VITEHUB_PROJECT_ROOT = "__vitehubProjectRoot" as const
/** The application's mount path, which can differ from Nuxt's Vite asset base. */
export const VITEHUB_APP_BASE_URL = "__vitehubAppBaseURL" as const
/**
 * Server directories that ViteHub scans for Definitions. The first entry is the application.
 * Later entries are Nuxt layers in Nuxt priority order.
 */
export const VITEHUB_SERVER_DIRS = "__vitehubServerDirs" as const

interface NuxtLayerDirectoryConfig {
  rootDir?: string
  serverDir?: string
  srcDir?: string
}

/** The Nuxt options that locate the server directory of each layer. */
export interface NuxtServerDirOptions extends NuxtLayerDirectoryConfig {
  _layers?: ReadonlyArray<{ config?: NuxtLayerDirectoryConfig, cwd?: string }>
}

/**
 * Lists the server directory of the application and of each Nuxt layer it extends.
 * The application comes first. Layers follow in Nuxt priority order, like Nuxt's own Nitro scan directories.
 */
export function resolveNuxtServerDirs(options: NuxtServerDirOptions): string[] | undefined {
  const appRoot = options.rootDir ? resolve(options.rootDir) : undefined
  let appDirectory = options.serverDir ? resolve(options.serverDir) : undefined
  const layerDirectories: string[] = []
  for (const layer of options._layers ?? []) {
    const root = layer.config?.rootDir ?? layer.cwd
    const isApp = Boolean(root && appRoot && resolve(root) === appRoot)
    if (isApp && appDirectory) continue
    // Nuxt resolves the application layer from its own options, as `getLayerDirectories()` in `@nuxt/kit` does.
    const config = isApp ? options : layer.config ?? {}
    const sourceDir = config.srcDir ?? layer.cwd ?? root
    if (!sourceDir) continue
    const directory = resolve(sourceDir, config.serverDir ?? "server")
    if (isApp) appDirectory = directory
    else layerDirectories.push(directory)
  }
  // The first entry always stands for the application, so layers never take its precedence.
  if (!appDirectory && layerDirectories.length && appRoot) appDirectory = resolve(appRoot, "server")
  const directories = [...new Set([...(appDirectory ? [appDirectory] : []), ...layerDirectories])]
  return directories.length ? directories : undefined
}

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

// Vite concatenates arrays when it merges a config hook result. Return only the missing pattern.
export function generatedViteHubWatchIgnoredAddition(ignored: WatchIgnoredValue): string[] | undefined {
  const values = Array.isArray(ignored) ? ignored : [ignored]
  return values.includes(generatedViteHubFilesPattern) ? undefined : [generatedViteHubFilesPattern]
}

export function resolveViteHubProjectRoot(root: string, options: { projectRoot?: string } = {}): string {
  const resolvedRoot = resolve(root)
  const temporaryRoot = resolve(tmpdir())
  const sharedTemporaryRoot = dirname(temporaryRoot) === parse(temporaryRoot).root ? temporaryRoot : undefined
  if (options.projectRoot) return resolve(resolvedRoot, options.projectRoot)

  if (basename(resolvedRoot) === "app") {
    const parent = dirname(resolvedRoot)
    if (parent !== sharedTemporaryRoot && (hasProjectRootDirectoryMarker(parent) || hasProjectRootFileMarker(parent, ["nuxt.config.ts", "nuxt.config.mts", "nuxt.config.js", "nuxt.config.mjs"]))) return parent
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
    : resolve(resolveViteHubProjectRoot(config.root ?? process.cwd()), ".vitehub")
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
  return hasProjectRootFileMarker(root, projectRootFileMarkers.flat())
}

function hasProjectRootFileMarker(root: string, markers: string[][] | string[]): boolean {
  for (const marker of markers) {
    const path = Array.isArray(marker) ? marker : [marker]
    try {
      if (statSync(resolve(root, ...path)).isFile()) return true
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

export function viteHubEnvDescriptionModulePath(root: string): string {
  return resolve(root, ".vitehub", "env", "description.mjs")
}

export function viteHubEnvServerModuleTypesPath(root: string): string {
  return resolve(root, ".vitehub", "env", "server.d.ts")
}

export function createViteHubEnvImportAliases(root: string): Record<string, string> {
  return {
    [VITEHUB_ENV_PUBLIC_ID]: viteHubEnvPublicModulePath(root),
    [VITEHUB_ENV_SERVER_ID]: viteHubEnvServerModulePath(root),
    [VITEHUB_ENV_DESCRIPTION_ID]: viteHubEnvDescriptionModulePath(root),
  }
}
