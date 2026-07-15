import { buildFeatureViteContext } from '@vite-hub/internal/feature-bridge'
import { createImportPath, ensureGeneratedDir } from '@vite-hub/internal/build/paths'
import { createNoExternalMerger, isServerEnvironment } from '@vite-hub/internal/build/vite'
import { writeFileIfChanged } from '@vite-hub/internal/definition-catalog'
import { normalize, relative, resolve } from 'pathe'

import { createFeatureVitePlugin } from './internal/shared/vite'
import { resolveFeatureRuntimePath } from './internal/shared/feature-runtime-path'
import { discoverSandboxDefinitions } from './discovery'
import { createSandboxFeaturePlan } from './feature'
import { sandboxFeatureEngine, type SandboxPublicOptions } from './integration'
import type { AgentSandboxConfig } from './module-types'
import type { EmittedArtifact, FeatureRuntimePlan } from './internal/shared/runtime-artifacts'
import type { Alias, AliasOptions, ConfigEnv, Plugin, ResolvedConfig } from 'vite'
import type { DiscoveredSandboxDefinition } from './discovery'

export { createViteHubDefinitionAutoImportsPlugin } from './internal/shared/vitehub-auto-imports'
export type { SandboxPublicOptions } from './integration'

export type SandboxVitePlugin = Plugin

const SANDBOX_PACKAGE_ID = '@vite-hub/sandbox'
const SANDBOX_PROVIDER_LOADER_ID = 'vitehub-sandbox-provider-loader'
const SANDBOX_REGISTRY_ID = '#vitehub-sandbox-registry'

type AliasMap = Record<string, string>
interface SandboxViteInternalOptions {
  providerImportAliases?: AliasMap
  providerImportSpecifier?: string
}
type SandboxAlias = Alias & { replacement: string }
type PreparedSandboxRuntime = {
  aliases: AliasMap
  definitions: DiscoveredSandboxDefinition[]
  files: string[]
}

const emptyPreparedSandboxRuntime: PreparedSandboxRuntime = {
  aliases: {},
  definitions: [],
  files: [],
}

function sandboxProviderLoaderFallback() {
  return resolveFeatureRuntimePath(import.meta.url, '@vite-hub/sandbox', './runtime/provider-loader', 'runtime/provider-loader.js')
}

function toSandboxAliasEntries(aliases: AliasMap): SandboxAlias[] {
  return Object.entries(aliases).map(([find, replacement]) => ({
    find: find === SANDBOX_PACKAGE_ID ? /^@vite-hub\/sandbox$/ : find,
    replacement,
  }))
}

function readAliasEntries(alias: unknown): Alias[] {
  if (Array.isArray(alias)) {
    return alias as Alias[]
  }

  if (!alias || typeof alias !== 'object')
    return []

  return Object.entries(alias as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([find, replacement]) => ({ find, replacement }))
}

function mergeAliases(alias: unknown, aliases: AliasMap): AliasOptions | undefined {
  const entries = [...toSandboxAliasEntries(aliases), ...readAliasEntries(alias)]
  return entries.length ? entries : undefined
}

function resolveStringAliases(alias: unknown): AliasMap {
  const aliases: AliasMap = {}
  for (const entry of readAliasEntries(alias)) {
    if (typeof entry.find === 'string' && typeof entry.replacement === 'string')
      aliases[entry.find] = entry.replacement
  }
  return aliases
}

function withoutSandboxPackageAlias(aliases: AliasMap): AliasMap {
  const { [SANDBOX_PACKAGE_ID]: _sandboxAlias, ...rest } = aliases
  return rest
}

function readResolveOptions(config: unknown): { alias?: unknown } {
  if (!config || typeof config !== 'object' || !('resolve' in config))
    return {}

  const resolve = (config as { resolve?: unknown }).resolve
  return resolve && typeof resolve === 'object'
    ? resolve as { alias?: unknown }
    : {}
}

function createSandboxRuntimeFacadeContents(file: string, runtimeConfig: unknown, registryFile: string) {
  const stateFile = resolveFeatureRuntimePath(import.meta.url, SANDBOX_PACKAGE_ID, './runtime/state', 'runtime/state.js')
  const packageIndexFile = resolveFeatureRuntimePath(import.meta.url, SANDBOX_PACKAGE_ID, './index', 'index.js')

  return [
    `import sandboxRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { setSandboxRuntimeConfig, setSandboxRuntimeRegistry } from ${JSON.stringify(createImportPath(file, stateFile))}`,
    '',
    `setSandboxRuntimeConfig(${JSON.stringify(runtimeConfig, null, 2)})`,
    'setSandboxRuntimeRegistry(sandboxRegistry)',
    '',
    `export * from ${JSON.stringify(createImportPath(file, packageIndexFile))}`,
    '',
  ].join('\n')
}

function createGeneratedAliasMap(rootDir: string, plan: FeatureRuntimePlan): AliasMap {
  const generatedDir = ensureGeneratedDir(rootDir, 'sandbox')
  const artifactPaths = new Map((plan.artifacts || []).map(artifact => [artifact.key, resolve(generatedDir, artifact.filename)]))
  const aliases: AliasMap = {
    [SANDBOX_PACKAGE_ID]: plan.manifest.aliasPath,
  }

  for (const alias of plan.aliases || []) {
    if (alias.value) {
      aliases[alias.key] = alias.value
      continue
    }
    if (alias.artifactKey && artifactPaths.has(alias.artifactKey))
      aliases[alias.key] = artifactPaths.get(alias.artifactKey)!
  }

  return aliases
}

async function writeSandboxArtifacts(rootDir: string, plan: FeatureRuntimePlan) {
  const generatedDir = ensureGeneratedDir(rootDir, 'sandbox')
  const emitted = new Map<string, EmittedArtifact>()
  const typeTemplate = plan.manifest.typeTemplate

  if (typeTemplate)
    await writeFileIfChanged(resolve(generatedDir, typeTemplate.filename), typeTemplate.contents)

  for (const artifact of plan.artifacts || []) {
    const dst = resolve(generatedDir, artifact.filename)
    const contents = artifact.contents ?? await artifact.getContents?.(emitted)
    if (typeof contents !== 'string')
      throw new Error(`[vitehub] Sandbox generated artifact "${artifact.key}" did not return contents.`)

    emitted.set(artifact.key, { ...artifact, contents, dst })
    await writeFileIfChanged(dst, contents)
  }

  return emitted
}

async function prepareSandboxRuntimeAliases(
  engine: typeof sandboxFeatureEngine,
  rawConfig: Record<string, unknown>,
  rawEnv: ConfigEnv,
  resolved: ResolvedConfig | undefined,
  options: { writeArtifacts?: boolean } = {},
): Promise<PreparedSandboxRuntime> {
  const rootDir = resolved?.root || resolve(process.cwd(), typeof rawConfig.root === 'string' ? rawConfig.root : '.')
  const context = await buildFeatureViteContext(engine, { ...rawConfig, root: rootDir }, rawEnv)
  const sandboxConfig = context?.config as AgentSandboxConfig | false | undefined
  if (!context || !sandboxConfig)
    return emptyPreparedSandboxRuntime

  const facadeFile = resolve(ensureGeneratedDir(rootDir, 'sandbox'), 'runtime/sandbox.mjs')
  const definitions = discoverSandboxDefinitions({ rootDir })
  const plan = await createSandboxFeaturePlan(
    sandboxConfig,
    definitions,
    { aliasPath: facadeFile },
    context.deps,
    context.hosting,
    {
      bundleAlias: resolveStringAliases(resolved?.resolve.alias ?? readResolveOptions(rawConfig).alias),
      rootDir,
      scanRoots: [rootDir],
      serverImports: { presets: [] },
    },
  )
  const aliases = createGeneratedAliasMap(rootDir, plan)
  if (options.writeArtifacts === false) {
    return {
      aliases,
      definitions,
      files: [],
    }
  }
  const emitted = await writeSandboxArtifacts(rootDir, plan)
  await writeFileIfChanged(
    facadeFile,
    createSandboxRuntimeFacadeContents(
      facadeFile,
      (context.runtimeConfig as { sandbox?: unknown }).sandbox ?? context.config,
      aliases[SANDBOX_REGISTRY_ID]!,
    ),
  )
  return {
    aliases,
    definitions,
    files: [facadeFile, ...Array.from(emitted.values(), artifact => artifact.dst)],
  }
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
  const engine = {
    ...sandboxFeatureEngine,
    readPublicOptions(source) {
      const configOptions = sandboxFeatureEngine.readPublicOptions(source)
      return source.kind === 'vite' && typeof configOptions === 'undefined'
        ? options
        : configOptions
    },
  } satisfies typeof sandboxFeatureEngine
  const plugin = createFeatureVitePlugin({
    ...engine,
  }) as SandboxVitePlugin
  const configHook = plugin.config
  const configEnvironment = plugin.configEnvironment
  const mergeNoExternal = createNoExternalMerger('@vite-hub/sandbox')
  let generatedAliases: AliasMap = {}
  let generatedFiles: string[] = []
  let definitions: DiscoveredSandboxDefinition[] = []
  let rawConfig: Record<string, unknown> = {}
  let rawEnv: ConfigEnv = { command: 'serve', mode: 'development' }
  let resolvedConfig: ResolvedConfig | undefined

  async function refreshSandboxRuntime() {
    const prepared = await prepareSandboxRuntimeAliases(engine, rawConfig, rawEnv, resolvedConfig)
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
    ...plugin,
    async config(config, env) {
      rawConfig = config as Record<string, unknown>
      rawEnv = env
      const result = typeof configHook === 'function'
        ? await configHook.call(this, config, env)
        : undefined
      const prepared = await prepareSandboxRuntimeAliases(engine, rawConfig, rawEnv, resolvedConfig, { writeArtifacts: false })
      generatedAliases = prepared.aliases
      generatedFiles = prepared.files
      definitions = prepared.definitions
      return {
        ...(result && typeof result === 'object' ? result : {}),
        resolve: {
          ...readResolveOptions(result),
          alias: mergeAliases(readResolveOptions(result).alias, {
            [SANDBOX_PROVIDER_LOADER_ID]: sandboxProviderLoaderFallback(),
            ...withoutSandboxPackageAlias(generatedAliases),
          }),
        },
      }
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
      const result = typeof configEnvironment === 'function'
        ? configEnvironment.call(this, name, config, undefined as never)
        : undefined
      if (!isServerEnvironment(name, config)) {
        return result
      }
      return {
        ...result,
        resolve: {
          ...readResolveOptions(result),
          alias: mergeAliases(readResolveOptions(result).alias, {
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
