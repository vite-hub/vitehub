import { createNoExternalMerger, hasNitroConfigContext, isServerEnvironment } from '@vite-hub/internal/build/vite'
import { getHostingProvider } from '@vite-hub/internal/hosting'
import { realpath } from 'node:fs/promises'
import { basename, dirname, normalize, relative } from 'pathe'

import { configureCloudflareSandboxNitro } from './cloudflare'
import { sandboxProviderLoaderSpecifiers, sandboxRuntimeDependencyByProvider } from './feature'
import { resolveFeatureRuntimePath } from './internal/shared/feature-runtime-path'
import { prepareSandboxRuntime } from './internal/runtime-preparation'
import type { Alias, ConfigEnv, Plugin, ResolvedConfig } from 'vite'
import type { DiscoveredSandboxDefinition } from './discovery'
import type { AgentSandboxConfig } from './module-types'

export type SandboxPublicOptions = AgentSandboxConfig | false
export type SandboxVitePlugin = Plugin & {
  nitro: {
    name: string
    setup: (nitro: {
      hooks: { hook: (name: 'build:before', callback: () => void) => void }
      options: Record<string, unknown>
    }) => void
  }
}

const SANDBOX_PACKAGE_ID = '@vite-hub/sandbox'
const SANDBOX_PROVIDER_LOADER_ID = 'vitehub-sandbox-provider-loader'
const SANDBOX_STATE_ID = '#vitehub/sandbox'
const RESOLVED_SANDBOX_STATE_ID = '\0vitehub:sandbox:state'

type AliasMap = Record<string, string>
interface SandboxViteInternalOptions {
  providerImportAliases?: AliasMap
  providerImportSpecifier?: string
}
type SandboxAlias = Alias & { replacement: string }
type SandboxHostingProvider = keyof typeof sandboxRuntimeDependencyByProvider

function mergeSandboxNitroProviderAliases(
  nitro: Record<string, unknown>,
  aliases: AliasMap,
) {
  const providerAliases = Object.fromEntries(
    sandboxProviderLoaderSpecifiers.flatMap((specifier) => {
      const replacement = aliases[specifier]
      return replacement ? [[specifier, replacement]] : []
    }),
  )
  if (!Object.keys(providerAliases).length)
    return

  const existing = nitro.alias && typeof nitro.alias === 'object' && !Array.isArray(nitro.alias)
    ? nitro.alias as AliasMap
    : {}
  nitro.alias = { ...existing, ...providerAliases }
}

function mergeSandboxNitroNoExternals(
  nitro: Record<string, unknown>,
  provider: string | undefined,
) {
  if (provider !== 'cloudflare' && provider !== 'vercel')
    return

  const existing = nitro.noExternals
  if (existing === true)
    return

  const existingEntries = Array.isArray(existing) ? existing : []
  const additions = [
    SANDBOX_PACKAGE_ID,
    sandboxRuntimeDependencyByProvider[provider],
  ]
  nitro.noExternals = [
    ...existingEntries,
    ...additions.filter(addition => !existingEntries.includes(addition)),
  ]
}

function sandboxProviderLoaderFallback() {
  return resolveFeatureRuntimePath(import.meta.url, '@vite-hub/sandbox', './runtime/provider-loader', 'runtime/provider-loader.js')
}

function sandboxPackageRuntime() {
  return dirname(resolveFeatureRuntimePath(import.meta.url, '@vite-hub/sandbox', './index', 'index.js'))
}

function toSandboxAliasEntries(aliases: AliasMap): SandboxAlias[] {
  return Object.entries(aliases).map(([find, replacement]) => ({
    find: find === SANDBOX_PACKAGE_ID ? /^@vite-hub\/sandbox$/ : find,
    replacement,
  }))
}

function withoutSandboxPackageAlias(aliases: AliasMap): AliasMap {
  const { [SANDBOX_PACKAGE_ID]: _sandboxAlias, ...rest } = aliases
  return rest
}

function isSandboxSourceFile(file: string) {
  return /\.(?:c|m)?[jt]s$/i.test(file) && !/\.d\.(?:c|m)?[jt]s$/i.test(file)
}

function isLocalSourceFile(file: string, rootDir: string | undefined) {
  if (!rootDir)
    return false

  const path = normalize(relative(rootDir, file))
  return path !== ''
    && !path.startsWith('../')
    && !path.startsWith('/')
    && !path.startsWith('node_modules/')
    && !path.startsWith('.vitehub/')
}

function isSandboxProjectManifestUpdate(
  file: string,
  rootDir: string | undefined,
) {
  if (basename(file) !== 'package.json' || !isLocalSourceFile(file, rootDir))
    return false
  const path = normalize(relative(rootDir!, file))
  return /(?:^|\/)(?:src\/)?server\/sandboxes\//.test(path)
}

function isSandboxProjectFileUpdate(file: string, rootDir: string | undefined) {
  if (!isLocalSourceFile(file, rootDir))
    return false
  const path = normalize(relative(rootDir!, file))
  return /(?:^|\/)(?:src\/)?server\/sandboxes\//.test(path)
    || /^(?:pnpm-workspace\.yaml|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lock)$/.test(path)
}

function isSandboxDefinitionUpdate(
  file: string,
  definitions: DiscoveredSandboxDefinition[],
  generatedFiles: string[],
  rootDir: string | undefined,
) {
  const changedFile = normalize(file)
  if (definitions.some(definition => normalize(definition.handler) === changedFile))
    return true
  if (generatedFiles.some(file => normalize(file) === changedFile))
    return false
  if (isSandboxProjectManifestUpdate(changedFile, rootDir))
    return true
  if (isSandboxProjectFileUpdate(changedFile, rootDir))
    return true
  if (!isSandboxSourceFile(changedFile))
    return false
  return /\.sandbox\.(?:c|m)?[jt]s$/i.test(changedFile)
    || /(?:^|\/)(?:src\/)?server\/sandboxes\//.test(changedFile)
    || isLocalSourceFile(changedFile, rootDir)
}

function invalidateGeneratedSandboxModules(files: string[], moduleGraph: { getModuleById: (id: string) => unknown, invalidateModule: (module: never) => void }) {
  for (const file of new Set(files.map(file => normalize(file)))) {
    const module = moduleGraph.getModuleById(file)
    if (module)
      moduleGraph.invalidateModule(module as never)
  }
}

async function resolveGeneratedSandboxModuleIds(files: string[]) {
  return Promise.all(files.map(async file => normalize(await realpath(file).catch(() => file))))
}

export function hubSandbox(options?: SandboxPublicOptions): SandboxVitePlugin {
  const internalOptions = options as SandboxPublicOptions & SandboxViteInternalOptions | undefined
  const integrationOptions = options && typeof options === 'object'
    ? Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'providerImportAliases' && key !== 'providerImportSpecifier')) as SandboxPublicOptions
    : options
  const mergeSandboxNoExternal = createNoExternalMerger('@vite-hub/sandbox')
  let generatedAliases: AliasMap = {}
  let generatedFiles: string[] = []
  let definitions: DiscoveredSandboxDefinition[] = []
  let rootDir: string | undefined
  let sandboxStateModule: string | undefined
  let rawConfig: Record<string, unknown> = {}
  let rawEnv: ConfigEnv = { command: 'serve', mode: 'development' }
  let resolvedConfig: ResolvedConfig | undefined
  let selectedProvider: SandboxHostingProvider | undefined
  let earlyNitroTarget: Record<string, unknown> | undefined
  let earlyNitroSnapshot: Record<string, unknown> | undefined
  let composedCloudflareEarly = false
  let sandboxRuntimeRefresh = Promise.resolve()
  const sandboxNitroModule = (nitro: {
    hooks: { hook: (name: 'build:before', callback: () => void) => void }
    options: Record<string, unknown>
  }) => {
    mergeSandboxNitroNoExternals(nitro.options, selectedProvider)
    if (selectedProvider)
      mergeSandboxNitroProviderAliases(nitro.options, generatedAliases)
    nitro.hooks.hook('build:before', () => {
      mergeSandboxNitroNoExternals(nitro.options, selectedProvider)
      if (selectedProvider)
        mergeSandboxNitroProviderAliases(nitro.options, generatedAliases)
    })
  }

  function cloneConfigValue<T>(value: T): T {
    if (Array.isArray(value))
      return value.map(cloneConfigValue) as T
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, cloneConfigValue(entry)]),
      ) as T
    }
    return value
  }

  async function prepareCurrentSandboxRuntime(writeArtifacts = true) {
    const prepared = await prepareSandboxRuntime({
      integrationOptions,
      userConfig: rawConfig,
      env: rawEnv,
      resolvedConfig,
      writeArtifacts,
    })
    sandboxStateModule = prepared.stateModule
    return prepared
  }

  async function refreshSandboxRuntime() {
    const refresh = sandboxRuntimeRefresh.then(async () => {
      const prepared = await prepareCurrentSandboxRuntime()
      generatedAliases = prepared.aliases
      generatedFiles = prepared.files
      definitions = prepared.definitions
      rootDir = prepared.rootDir
      if (internalOptions?.providerImportAliases && internalOptions.providerImportSpecifier) {
        const facade = generatedAliases[SANDBOX_PACKAGE_ID]
        if (facade) {
          internalOptions.providerImportAliases[internalOptions.providerImportSpecifier] = facade
          internalOptions.providerImportAliases[SANDBOX_PACKAGE_ID] = sandboxPackageRuntime()
        }
        else {
          delete internalOptions.providerImportAliases[internalOptions.providerImportSpecifier]
          delete internalOptions.providerImportAliases[SANDBOX_PACKAGE_ID]
        }
        for (const specifier of sandboxProviderLoaderSpecifiers) {
          const providerLoader = generatedAliases[specifier]
          if (providerLoader)
            internalOptions.providerImportAliases[specifier] = providerLoader
          else
            delete internalOptions.providerImportAliases[specifier]
        }
      }
      return prepared
    })
    sandboxRuntimeRefresh = refresh.then(() => undefined, () => undefined)
    return await refresh
  }

  async function composeCloudflareSandbox(
    config: { nitro?: unknown, plugins?: unknown, root?: string },
    prepared: Awaited<ReturnType<typeof prepareCurrentSandboxRuntime>>,
  ) {
    if (!prepared.cloudflare || !hasNitroConfigContext(config) || getHostingProvider(prepared.hosting) !== 'cloudflare')
      return false
    config.nitro = await configureCloudflareSandboxNitro(
      config.nitro as Parameters<typeof configureCloudflareSandboxNitro>[0],
      prepared.rootDir,
      prepared.cloudflare,
    )
    return true
  }

  return {
    name: '@vite-hub/sandbox/vite',
    enforce: 'pre',
    nitro: { name: '@vite-hub/sandbox/provider-runtime', setup: sandboxNitroModule },
    async config(config, env) {
      rawConfig = config as Record<string, unknown>
      rawEnv = env
      const prepared = await prepareCurrentSandboxRuntime(false)
      generatedAliases = prepared.aliases
      generatedFiles = prepared.files
      definitions = prepared.definitions
      rootDir = prepared.rootDir
      selectedProvider = prepared.provider
      const nitro = (config as { nitro?: unknown }).nitro
      if (nitro && typeof nitro === 'object') {
        earlyNitroTarget = nitro as Record<string, unknown>
        earlyNitroSnapshot = cloneConfigValue(earlyNitroTarget)
      }
      composedCloudflareEarly = await composeCloudflareSandbox(config, prepared)
      return {
        resolve: {
          alias: toSandboxAliasEntries({
            [SANDBOX_PROVIDER_LOADER_ID]: sandboxProviderLoaderFallback(),
            ...withoutSandboxPackageAlias(generatedAliases),
          }),
        },
      }
    },
    resolveId(id) {
      if (!sandboxStateModule)
        return
      if (id === SANDBOX_STATE_ID)
        return RESOLVED_SANDBOX_STATE_ID
      if (id === RESOLVED_SANDBOX_STATE_ID)
        return id
    },
    load(id) {
      if (id === SANDBOX_STATE_ID || id === RESOLVED_SANDBOX_STATE_ID)
        return sandboxStateModule
    },
    async configResolved(config) {
      resolvedConfig = config
      const prepared = await refreshSandboxRuntime()
      selectedProvider = prepared.provider
      const composed = await composeCloudflareSandbox(config, prepared)
      if (!composed && composedCloudflareEarly && earlyNitroTarget && earlyNitroSnapshot) {
        for (const key of ['cloudflare', 'rollupConfig']) {
          if (key in earlyNitroSnapshot)
            earlyNitroTarget[key] = earlyNitroSnapshot[key]
          else
            delete earlyNitroTarget[key]
        }
      }
    },
    async handleHotUpdate(context) {
      if (!isSandboxDefinitionUpdate(context.file, definitions, generatedFiles, rootDir))
        return

      const previousFiles = [...generatedFiles, ...Object.values(generatedAliases)]
      const previousResolvedFiles = await resolveGeneratedSandboxModuleIds(previousFiles)
      const prepared = await refreshSandboxRuntime()
      selectedProvider = prepared.provider
      if (resolvedConfig)
        await composeCloudflareSandbox(resolvedConfig, prepared)
      const currentFiles = [...generatedFiles, ...Object.values(generatedAliases)]
      const currentResolvedFiles = await resolveGeneratedSandboxModuleIds(currentFiles)
      invalidateGeneratedSandboxModules([...previousFiles, ...previousResolvedFiles, ...currentFiles, ...currentResolvedFiles], context.server.moduleGraph)
    },
    configEnvironment(name, config) {
      const result = config.consumer === 'server'
        ? {
            define: {
              __VITEHUB_ENVIRONMENT_SANDBOX__: JSON.stringify(name),
            },
          }
        : undefined
      if (!isServerEnvironment(name, config)) {
        return result
      }
      return {
        ...result,
        resolve: {
          alias: toSandboxAliasEntries({
            [SANDBOX_PROVIDER_LOADER_ID]: sandboxProviderLoaderFallback(),
            ...generatedAliases,
          }),
          noExternal: mergeSandboxNoExternal(config.resolve?.noExternal),
        },
      }
    },
  }
}

declare module 'vite' {
  interface UserConfig {
    sandbox?: SandboxPublicOptions
  }
}
