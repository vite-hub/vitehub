import { readFile } from 'node:fs/promises'

import { createImportPath, ensureGeneratedDir } from '@vite-hub/internal/build/paths'
import { createNoExternalMerger, isServerEnvironment } from '@vite-hub/internal/build/vite'
import { writeFileIfChanged } from '@vite-hub/internal/definition-catalog'
import { detectHosting } from '@vite-hub/internal/feature-bridge/hosting'
import { isPlainObject } from '@vite-hub/internal/object'
import { normalize, relative, resolve } from 'pathe'

import { resolveFeatureRuntimePath } from './internal/shared/feature-runtime-path'
import { discoverSandboxDefinitions } from './discovery'
import { createSandboxFeaturePlan, resolveSandboxFeatureConfig } from './feature'
import { getSandboxFeatureProvider } from './module-types'
import type { EmittedArtifact, FeatureRuntimePlan } from './internal/shared/runtime-artifacts'
import type { Alias, AliasOptions, ConfigEnv, Plugin, ResolvedConfig } from 'vite'
import type { DiscoveredSandboxDefinition } from './discovery'
import type { AgentSandboxConfig } from './module-types'

export { createViteHubDefinitionAutoImportsPlugin } from './internal/shared/vitehub-auto-imports'

export type SandboxPublicOptions = AgentSandboxConfig | false
export type SandboxVitePlugin = Plugin

const SANDBOX_PACKAGE_ID = '@vite-hub/sandbox'
const SANDBOX_PROVIDER_LOADER_ID = 'vitehub-sandbox-provider-loader'
const SANDBOX_REGISTRY_ID = '#vitehub-sandbox-registry'
const SANDBOX_STATE_ID = '#vitehub/sandbox'
const RESOLVED_SANDBOX_STATE_ID = '\0vitehub:sandbox:state'

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
type SandboxViteContext = {
  rootDir: string
  config: AgentSandboxConfig | false
  deps: Record<string, string>
  runtimeConfig: Record<string, unknown>
  hosting?: string
  command: ConfigEnv['command']
  mode: string
}

const emptyPreparedSandboxRuntime: PreparedSandboxRuntime = {
  aliases: {},
  definitions: [],
  files: [],
}

function normalizeSandboxOptions(options: SandboxPublicOptions): AgentSandboxConfig | false {
  if (options === false)
    return false
  if (!isPlainObject(options))
    throw new TypeError('[vitehub] `sandbox` must be a plain object.')
  return { ...options } as AgentSandboxConfig
}

function assignSandboxRuntimeConfig(runtimeConfig: Record<string, unknown>, config: AgentSandboxConfig | false) {
  if (config === false) {
    runtimeConfig.sandbox = false
    return
  }

  const provider = getSandboxFeatureProvider(config)
  runtimeConfig.sandbox = provider?.provider === 'vercel'
    ? {
        ...config,
        token: provider.token ?? '',
        teamId: provider.teamId ?? '',
        projectId: provider.projectId ?? '',
      }
    : config
}

async function readSandboxWorkspaceDeps(rootDir: string) {
  const packageJson = JSON.parse(await readFile(resolve(rootDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  return {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  }
}

async function resolveSandboxViteContext(
  integrationOptions: SandboxPublicOptions | undefined,
  userConfig: Record<string, unknown>,
  env: ConfigEnv,
): Promise<SandboxViteContext> {
  const configOptions = userConfig.sandbox as SandboxPublicOptions | undefined
  const options = normalizeSandboxOptions(
    typeof configOptions === 'undefined' ? integrationOptions ?? {} : configOptions,
  )
  const hosting = detectHosting({ options: userConfig as { preset?: string | null } }) || undefined
  const config = options === false ? false : resolveSandboxFeatureConfig(options, hosting)
  const rootDir = resolve(process.cwd(), typeof userConfig.root === 'string' ? userConfig.root : '.')
  const runtimeConfig: Record<string, unknown> = {}
  if (hosting)
    runtimeConfig.hosting = hosting
  assignSandboxRuntimeConfig(runtimeConfig, config)

  return {
    rootDir,
    config,
    deps: await readSandboxWorkspaceDeps(rootDir),
    runtimeConfig,
    hosting,
    command: env.command,
    mode: env.mode,
  }
}

function createSandboxStateModuleContents(context: SandboxViteContext) {
  const state = {
    feature: 'sandbox',
    configKey: 'sandbox',
    config: context.config,
    runtimeConfig: context.runtimeConfig,
    hosting: context.hosting,
    rootDir: context.rootDir,
    mode: context.mode,
    command: context.command,
  }

  return [
    `const state = ${JSON.stringify(state, null, 2)}`,
    'export const feature = state.feature',
    'export const configKey = state.configKey',
    'export const config = state.config',
    'export const runtimeConfig = state.runtimeConfig',
    'export const hosting = state.hosting',
    'export const rootDir = state.rootDir',
    'export const mode = state.mode',
    'export const command = state.command',
    'export default state',
    '',
  ].join('\n')
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
  context: SandboxViteContext,
  rawConfig: Record<string, unknown>,
  resolved: ResolvedConfig | undefined,
  options: { writeArtifacts?: boolean } = {},
): Promise<PreparedSandboxRuntime> {
  const rootDir = context.rootDir
  const sandboxConfig = context.config
  if (!sandboxConfig)
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
      context.runtimeConfig.sandbox ?? context.config,
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
  const mergeNoExternal = createNoExternalMerger('@vite-hub/sandbox')
  let generatedAliases: AliasMap = {}
  let generatedFiles: string[] = []
  let definitions: DiscoveredSandboxDefinition[] = []
  let sandboxStateModule: string | undefined
  let rawConfig: Record<string, unknown> = {}
  let rawEnv: ConfigEnv = { command: 'serve', mode: 'development' }
  let resolvedConfig: ResolvedConfig | undefined

  async function resolveCurrentSandboxContext() {
    const rootDir = resolvedConfig?.root || resolve(process.cwd(), typeof rawConfig.root === 'string' ? rawConfig.root : '.')
    const context = await resolveSandboxViteContext(options, { ...rawConfig, root: rootDir }, rawEnv)
    sandboxStateModule = createSandboxStateModuleContents(context)
    return context
  }

  async function refreshSandboxRuntime() {
    const context = await resolveCurrentSandboxContext()
    const prepared = await prepareSandboxRuntimeAliases(context, rawConfig, resolvedConfig)
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
      const context = await resolveCurrentSandboxContext()
      const prepared = await prepareSandboxRuntimeAliases(context, rawConfig, resolvedConfig, { writeArtifacts: false })
      generatedAliases = prepared.aliases
      generatedFiles = prepared.files
      definitions = prepared.definitions
      return {
        resolve: {
          alias: mergeAliases(undefined, {
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
