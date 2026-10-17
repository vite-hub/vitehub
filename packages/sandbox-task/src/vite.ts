import { createNoExternalAddition, hasNitroConfigContext, isServerEnvironment, resolveViteHubProjectRoot } from '@vite-hub/internal/build/vite'
import { getHostingProvider } from '@vite-hub/internal/hosting'
import { isPlainObject, isPlainRecord } from '@vite-hub/internal/object'
import { realpath } from 'node:fs/promises'
import { basename, normalize, relative } from 'pathe'

import { configureCloudflareSandboxNitro } from './cloudflare'
import {
  sandboxTaskProviderLoaderSpecifiers,
  sandboxTaskRuntimeDependencyByProvider,
  sandboxTaskRuntimeProviderSpecifiers,
  sandboxTaskRuntimeSpecifier,
  sandboxTaskRuntimeStateSpecifier,
} from './feature'
import { resolveFeatureRuntimePath } from './internal/shared/feature-runtime-path'
import { prepareSandboxTaskRuntime } from './internal/runtime-preparation'
import { inspectSandboxTaskDefinitions } from './inspect'
import type { ViteHubInspectionPluginMetadata } from '@vite-hub/internal/inspect'
import type { Alias, ConfigEnv, Plugin, ResolvedConfig } from 'vite'
import type { DiscoveredSandboxTaskDefinition } from './discovery'
import type { AgentSandboxTaskConfig } from './module-types'

export { discoverSandboxTaskDefinitions } from './discovery'
export type { DiscoveredSandboxTaskDefinition } from './discovery'
export { inspectSandboxTaskDefinitions, type SandboxTaskInspectionOptions, sandboxTaskConsoleSection } from './inspect'

export type SandboxTaskPublicOptions = AgentSandboxTaskConfig | false
export type SandboxTaskVitePlugin = Plugin & {
  vitehub: ViteHubInspectionPluginMetadata
  nitro: {
    name: string
    setup: (nitro: {
      hooks: { hook: (name: 'build:before', callback: () => void) => void }
      options: Record<string, unknown>
    }) => void
  }
}

const SANDBOX_PACKAGE_ID = '@vite-hub/sandbox-task'
const SANDBOX_PROVIDER_LOADER_ID = 'vitehub-sandbox-task-provider-loader'
const SANDBOX_STATE_ID = '#vitehub/sandbox-task'
const RESOLVED_SANDBOX_STATE_ID = '\0vitehub:sandbox-task:state'

type AliasMap = Record<string, string>
interface SandboxTaskViteInternalOptions {
  providerImportAliases?: AliasMap
  providerImportSpecifier?: string
}
type SandboxTaskAlias = Alias & { replacement: string }
type SandboxTaskHostingProvider = keyof typeof sandboxTaskRuntimeDependencyByProvider

function mergeSandboxTaskNitroProviderAliases(
  nitro: Record<string, unknown>,
  aliases: AliasMap,
) {
  const providerAliases = Object.fromEntries(
    sandboxTaskProviderLoaderSpecifiers.flatMap((specifier) => {
      const replacement = aliases[specifier]
      return replacement ? [[specifier, replacement]] : []
    }),
  )
  if (!Object.keys(providerAliases).length)
    return

  const existing = isPlainObject(nitro.alias) ? nitro.alias : {}
  nitro.alias = { ...existing, ...providerAliases }
}

function mergeSandboxTaskNitroNoExternals(
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
    sandboxTaskRuntimeDependencyByProvider[provider],
  ]
  nitro.noExternals = [
    ...existingEntries,
    ...additions.filter(addition => !existingEntries.includes(addition)),
  ]
}

function sandboxTaskProviderLoaderFallback() {
  return resolveFeatureRuntimePath(import.meta.url, '@vite-hub/sandbox-task', './runtime/provider-loader', 'runtime/provider-loader.js')
}

const sandboxTaskRuntimePackageAliases: AliasMap = {
  [sandboxTaskRuntimeProviderSpecifiers.cloudflare]: resolveFeatureRuntimePath(import.meta.url, SANDBOX_PACKAGE_ID, './runtime/providers/cloudflare', 'runtime/providers/cloudflare.js'),
  [sandboxTaskRuntimeProviderSpecifiers.vercel]: resolveFeatureRuntimePath(import.meta.url, SANDBOX_PACKAGE_ID, './runtime/providers/vercel', 'runtime/providers/vercel.js'),
  [sandboxTaskRuntimeSpecifier]: resolveFeatureRuntimePath(import.meta.url, SANDBOX_PACKAGE_ID, './index', 'index.js'),
  [sandboxTaskRuntimeStateSpecifier]: resolveFeatureRuntimePath(import.meta.url, SANDBOX_PACKAGE_ID, './runtime/state', 'runtime/state.js'),
}

function toSandboxTaskAliasEntries(aliases: AliasMap): SandboxTaskAlias[] {
  return Object.entries(aliases).map(([find, replacement]) => ({
    find: find === SANDBOX_PACKAGE_ID ? /^@vite-hub\/sandbox-task$/ : find,
    replacement,
  }))
}

function withoutSandboxTaskPackageAlias(aliases: AliasMap): AliasMap {
  const { [SANDBOX_PACKAGE_ID]: _sandboxTaskAlias, ...rest } = aliases
  return rest
}

function isSandboxTaskSourceFile(file: string) {
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

function isSandboxTaskProjectManifestUpdate(
  file: string,
  rootDir: string | undefined,
) {
  if (basename(file) !== 'package.json' || !isLocalSourceFile(file, rootDir))
    return false
  const path = normalize(relative(rootDir!, file))
  return /(?:^|\/)(?:src\/)?server\/sandbox-tasks\//.test(path)
}

function isSandboxTaskProjectFileUpdate(file: string, rootDir: string | undefined) {
  if (!isLocalSourceFile(file, rootDir))
    return false
  const path = normalize(relative(rootDir!, file))
  return /(?:^|\/)(?:src\/)?server\/sandbox-tasks\//.test(path)
    || /^(?:pnpm-workspace\.yaml|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lock)$/.test(path)
}

function isSandboxTaskDefinitionUpdate(
  file: string,
  definitions: DiscoveredSandboxTaskDefinition[],
  generatedFiles: string[],
  watchFiles: string[],
  rootDir: string | undefined,
) {
  const changedFile = normalize(file)
  if (definitions.some(definition => normalize(definition.handler) === changedFile))
    return true
  if (generatedFiles.some(file => normalize(file) === changedFile))
    return false
  if (watchFiles.some(file => normalize(file) === changedFile))
    return true
  if (isSandboxTaskProjectManifestUpdate(changedFile, rootDir))
    return true
  if (isSandboxTaskProjectFileUpdate(changedFile, rootDir))
    return true
  if (isLocalSourceFile(changedFile, rootDir))
    return true
  if (!isSandboxTaskSourceFile(changedFile))
    return false
  return /\.sandbox-task\.(?:c|m)?[jt]s$/i.test(changedFile)
    || /(?:^|\/)(?:src\/)?server\/sandbox-tasks\//.test(changedFile)
    || isLocalSourceFile(changedFile, rootDir)
}

function invalidateGeneratedSandboxTaskModules(files: string[], moduleGraph: { getModuleById: (id: string) => unknown, invalidateModule: (module: never) => void }) {
  for (const file of new Set(files.map(file => normalize(file)))) {
    const module = moduleGraph.getModuleById(file)
    if (module) {
      // SAFETY: Vite returned this value from the same module graph that accepts it for invalidation.
      moduleGraph.invalidateModule(module as never)
    }
  }
}

async function resolveGeneratedSandboxTaskModuleIds(files: string[]) {
  return Promise.all(files.map(async file => normalize(await realpath(file).catch(() => file))))
}

function publicSandboxTaskOptions(options: AgentSandboxTaskConfig & SandboxTaskViteInternalOptions): SandboxTaskPublicOptions {
  // SAFETY: Removing the two package-private integration fields leaves the declared public Sandbox options.
  return Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'providerImportAliases' && key !== 'providerImportSpecifier')) as SandboxTaskPublicOptions
}

function mutableSandboxTaskNitroTarget(value: unknown): Parameters<typeof configureCloudflareSandboxNitro>[0] {
  // SAFETY: The caller first establishes Vite's Nitro config context before passing its Nitro value.
  return value as Parameters<typeof configureCloudflareSandboxNitro>[0]
}

export function hubSandboxTask(options?: SandboxTaskPublicOptions): SandboxTaskVitePlugin {
  // SAFETY: ViteHub adds these package-private integration fields before composing the Sandbox plugin.
  const internalOptions = options as SandboxTaskPublicOptions & SandboxTaskViteInternalOptions | undefined
  const integrationOptions = internalOptions
    ? publicSandboxTaskOptions(internalOptions)
    : internalOptions
  const mergeSandboxTaskNoExternal = createNoExternalAddition('@vite-hub/sandbox-task')
  let generatedAliases: AliasMap = {}
  let generatedFiles: string[] = []
  let watchFiles: string[] = []
  let definitions: DiscoveredSandboxTaskDefinition[] = []
  let rootDir: string | undefined
  let sandboxTaskStateModule: string | undefined
  let rawConfig: Record<string, unknown> = {}
  let rawEnv: ConfigEnv = { command: 'serve', mode: 'development' }
  let resolvedConfig: ResolvedConfig | undefined
  let sandboxTaskEnabled = integrationOptions !== false
  let selectedProvider: SandboxTaskHostingProvider | undefined
  let earlyNitroTarget: Record<string, unknown> | undefined
  let earlyNitroSnapshot: Record<string, unknown> | undefined
  let composedCloudflareEarly = false
  let sandboxTaskRuntimeRefresh = Promise.resolve()
  const sandboxTaskNitroModule = (nitro: {
    hooks: { hook: (name: 'build:before', callback: () => void) => void }
    options: Record<string, unknown>
  }) => {
    mergeSandboxTaskNitroNoExternals(nitro.options, selectedProvider)
    if (selectedProvider)
      mergeSandboxTaskNitroProviderAliases(nitro.options, generatedAliases)
    nitro.hooks.hook('build:before', () => {
      mergeSandboxTaskNitroNoExternals(nitro.options, selectedProvider)
      if (selectedProvider)
        mergeSandboxTaskNitroProviderAliases(nitro.options, generatedAliases)
    })
  }

  function cloneConfigValue<T>(value: T): T {
    if (Array.isArray(value)) {
      // SAFETY: Mapping an array recursively preserves the input array's generic structure.
      return value.map(cloneConfigValue) as T
    }
    if (isPlainRecord(value) && Object.getPrototypeOf(value) === Object.prototype) {
      // SAFETY: Reconstructing a plain record recursively preserves the input record's generic structure.
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, cloneConfigValue(entry)]),
      ) as T
    }
    return value
  }

  async function prepareCurrentSandboxTaskRuntime(writeArtifacts = true) {
    const prepared = await prepareSandboxTaskRuntime({
      integrationOptions,
      userConfig: rawConfig,
      env: rawEnv,
      resolvedConfig,
      writeArtifacts,
    })
    sandboxTaskStateModule = prepared.stateModule
    return prepared
  }

  async function activateCurrentSandboxTaskRuntime() {
    const prepared = await prepareCurrentSandboxTaskRuntime()
    generatedAliases = prepared.aliases
    generatedFiles = prepared.files
    watchFiles = prepared.watchFiles
    definitions = prepared.definitions
    rootDir = prepared.rootDir
    if (internalOptions?.providerImportAliases && internalOptions.providerImportSpecifier) {
      const facade = generatedAliases[SANDBOX_PACKAGE_ID]
      if (facade) {
        internalOptions.providerImportAliases[internalOptions.providerImportSpecifier] = facade
        Object.assign(internalOptions.providerImportAliases, sandboxTaskRuntimePackageAliases)
      }
      else {
        delete internalOptions.providerImportAliases[internalOptions.providerImportSpecifier]
        for (const specifier of Object.keys(sandboxTaskRuntimePackageAliases))
          delete internalOptions.providerImportAliases[specifier]
      }
      for (const specifier of sandboxTaskProviderLoaderSpecifiers) {
        const providerLoader = generatedAliases[specifier]
        if (providerLoader)
          internalOptions.providerImportAliases[specifier] = providerLoader
        else
          delete internalOptions.providerImportAliases[specifier]
      }
    }
    return prepared
  }

  async function refreshSandboxTaskRuntime(
    transaction: (
      refresh: () => ReturnType<typeof activateCurrentSandboxTaskRuntime>,
    ) => ReturnType<typeof activateCurrentSandboxTaskRuntime> = refresh => refresh(),
  ) {
    const refresh = sandboxTaskRuntimeRefresh.then(() => transaction(activateCurrentSandboxTaskRuntime))
    sandboxTaskRuntimeRefresh = refresh.then(() => undefined, () => undefined)
    return await refresh
  }

  async function composeCloudflareSandbox(
    config: { nitro?: unknown, plugins?: unknown, root?: string },
    prepared: Awaited<ReturnType<typeof prepareCurrentSandboxTaskRuntime>>,
    finalizeWrangler = false,
  ) {
    if (!prepared.cloudflare || !hasNitroConfigContext(config) || getHostingProvider(prepared.hosting) !== 'cloudflare')
      return false
    config.nitro = await configureCloudflareSandboxNitro(
      mutableSandboxTaskNitroTarget(config.nitro),
      prepared.rootDir,
      prepared.cloudflare,
      finalizeWrangler,
    )
    return true
  }

  return {
    name: '@vite-hub/sandbox-task/vite',
    enforce: 'pre',
    nitro: { name: '@vite-hub/sandbox-task/provider-runtime', setup: sandboxTaskNitroModule },
    vitehub: {
      inspect: () => sandboxTaskEnabled ? ({
        definitions: [{
          kind: 'sandbox-task',
          label: 'Sandbox Tasks',
          list: () => {
            const sandboxTaskRoot = rootDir ?? resolvedConfig?.root ?? process.cwd()
            return inspectSandboxTaskDefinitions({ projectRoot: resolveViteHubProjectRoot(sandboxTaskRoot), rootDir: sandboxTaskRoot })
          },
        }],
      }) : undefined,
    },
    async config(config, env) {
      // SAFETY: Vite's config hook provides the mutable record stored for later Sandbox preparation.
      rawConfig = config as Record<string, unknown>
      rawEnv = env
      const prepared = await prepareCurrentSandboxTaskRuntime(false)
      sandboxTaskEnabled = rawConfig.sandboxTask !== false && integrationOptions !== false
      generatedAliases = prepared.aliases
      generatedFiles = prepared.files
      watchFiles = prepared.watchFiles
      definitions = prepared.definitions
      rootDir = prepared.rootDir
      selectedProvider = prepared.provider
      // SAFETY: Vite integrations may contribute Nitro config outside Vite's public UserConfig type.
      const nitro = (config as { nitro?: unknown }).nitro
      if (isPlainObject(nitro)) {
        earlyNitroTarget = nitro
        earlyNitroSnapshot = cloneConfigValue(earlyNitroTarget)
      }
      composedCloudflareEarly = await composeCloudflareSandbox(config, prepared)
      return {
        resolve: {
          alias: toSandboxTaskAliasEntries({
            [SANDBOX_PROVIDER_LOADER_ID]: sandboxTaskProviderLoaderFallback(),
            ...withoutSandboxTaskPackageAlias(generatedAliases),
          }),
        },
      }
    },
    resolveId(id) {
      if (!sandboxTaskStateModule)
        return
      if (id === SANDBOX_STATE_ID)
        return RESOLVED_SANDBOX_STATE_ID
      if (id === RESOLVED_SANDBOX_STATE_ID)
        return id
    },
    load(id) {
      if (id === SANDBOX_STATE_ID || id === RESOLVED_SANDBOX_STATE_ID)
        return sandboxTaskStateModule
    },
    async configResolved(config) {
      resolvedConfig = config
      const prepared = await refreshSandboxTaskRuntime()
      sandboxTaskEnabled = rawConfig.sandboxTask !== false && integrationOptions !== false
      selectedProvider = prepared.provider
      const composed = await composeCloudflareSandbox(config, prepared, true)
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
      if (!isSandboxTaskDefinitionUpdate(context.file, definitions, generatedFiles, watchFiles, rootDir))
        return

      await refreshSandboxTaskRuntime(async (refresh) => {
        const previousFiles = [...generatedFiles, ...Object.values(generatedAliases)]
        const previousResolvedFiles = await resolveGeneratedSandboxTaskModuleIds(previousFiles)
        const prepared = await refresh()
        selectedProvider = prepared.provider
        if (resolvedConfig)
          await composeCloudflareSandbox(resolvedConfig, prepared, true)
        const currentFiles = [...generatedFiles, ...Object.values(generatedAliases)]
        const currentResolvedFiles = await resolveGeneratedSandboxTaskModuleIds(currentFiles)
        invalidateGeneratedSandboxTaskModules([...previousFiles, ...previousResolvedFiles, ...currentFiles, ...currentResolvedFiles], context.server.moduleGraph)
        return prepared
      })
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
          alias: toSandboxTaskAliasEntries({
            [SANDBOX_PROVIDER_LOADER_ID]: sandboxTaskProviderLoaderFallback(),
            ...generatedAliases,
          }),
          noExternal: mergeSandboxTaskNoExternal(config.resolve?.noExternal),
        },
      }
    },
  }
}

declare module 'vite' {
  interface UserConfig {
    sandboxTask?: SandboxTaskPublicOptions
  }
}
