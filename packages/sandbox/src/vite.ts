import { createNoExternalMerger, hasNitroVitePlugin, isServerEnvironment } from '@vite-hub/internal/build/vite'
import { normalize, relative } from 'pathe'

import { configureCloudflareSandboxNitro } from './cloudflare'
import { resolveFeatureRuntimePath } from './internal/shared/feature-runtime-path'
import { prepareSandboxRuntime } from './internal/runtime-preparation'
import type { Alias, ConfigEnv, Plugin, ResolvedConfig } from 'vite'
import type { DiscoveredSandboxDefinition } from './discovery'
import type { AgentSandboxConfig } from './module-types'

export type SandboxPublicOptions = AgentSandboxConfig | false
export type SandboxVitePlugin = Plugin

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

function sandboxProviderLoaderFallback() {
  return resolveFeatureRuntimePath(import.meta.url, '@vite-hub/sandbox', './runtime/provider-loader', 'runtime/provider-loader.js')
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
  if (!isSandboxSourceFile(changedFile))
    return false
  return /\.sandbox\.(?:c|m)?[jt]s$/i.test(changedFile)
    || /(?:^|\/)(?:src\/)?server\/sandboxes\//.test(changedFile)
    || isLocalSourceFile(changedFile, rootDir)
}

function invalidateGeneratedSandboxModules(files: string[], moduleGraph: { getModuleById: (id: string) => unknown, invalidateModule: (module: never) => void }) {
  for (const file of [...new Set(files.map(file => normalize(file)))]) {
    const module = moduleGraph.getModuleById(file)
    if (module)
      moduleGraph.invalidateModule(module as never)
  }
}

export function hubSandbox(options?: SandboxPublicOptions): SandboxVitePlugin {
  const internalOptions = options as SandboxPublicOptions & SandboxViteInternalOptions | undefined
  const mergeNoExternal = createNoExternalMerger('@vite-hub/sandbox')
  let generatedAliases: AliasMap = {}
  let generatedFiles: string[] = []
  let definitions: DiscoveredSandboxDefinition[] = []
  let sandboxStateModule: string | undefined
  let rawConfig: Record<string, unknown> = {}
  let rawEnv: ConfigEnv = { command: 'serve', mode: 'development' }
  let resolvedConfig: ResolvedConfig | undefined

  async function prepareCurrentSandboxRuntime(writeArtifacts = true) {
    const prepared = await prepareSandboxRuntime({
      integrationOptions: options,
      userConfig: rawConfig,
      env: rawEnv,
      resolvedConfig,
      writeArtifacts,
    })
    sandboxStateModule = prepared.stateModule
    return prepared
  }

  async function refreshSandboxRuntime() {
    const prepared = await prepareCurrentSandboxRuntime()
    generatedAliases = prepared.aliases
    generatedFiles = prepared.files
    definitions = prepared.definitions
    if (internalOptions?.providerImportAliases && internalOptions.providerImportSpecifier) {
      const facade = generatedAliases[SANDBOX_PACKAGE_ID]
      if (facade) {
        internalOptions.providerImportAliases[SANDBOX_PACKAGE_ID] = facade
        internalOptions.providerImportAliases[internalOptions.providerImportSpecifier] = facade
      }
      else {
        delete internalOptions.providerImportAliases[SANDBOX_PACKAGE_ID]
        delete internalOptions.providerImportAliases[internalOptions.providerImportSpecifier]
      }
    }
    return prepared
  }

  return {
    name: '@vite-hub/sandbox/vite',
    enforce: 'pre',
    async config(config, env) {
      rawConfig = config as Record<string, unknown>
      rawEnv = env
      const prepared = await prepareCurrentSandboxRuntime(false)
      generatedAliases = prepared.aliases
      generatedFiles = prepared.files
      definitions = prepared.definitions
      if (prepared.cloudflare && hasNitroVitePlugin(config)) {
        const configWithNitro = config as typeof config & { nitro?: Parameters<typeof configureCloudflareSandboxNitro>[0] }
        configWithNitro.nitro = await configureCloudflareSandboxNitro(
          configWithNitro.nitro,
          config.root || process.cwd(),
          prepared.cloudflare,
        )
      }
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
      await refreshSandboxRuntime()
    },
    async handleHotUpdate(context) {
      if (!isSandboxDefinitionUpdate(context.file, definitions, generatedFiles, resolvedConfig?.root))
        return

      const previousFiles = [...generatedFiles, ...Object.values(generatedAliases)]
      await refreshSandboxRuntime()
      invalidateGeneratedSandboxModules([...previousFiles, ...generatedFiles, ...Object.values(generatedAliases)], context.server.moduleGraph)
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
          noExternal: mergeNoExternal(config.resolve?.noExternal),
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
