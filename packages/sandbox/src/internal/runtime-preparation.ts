import { readFile, rm } from 'node:fs/promises'
import { builtinModules } from 'node:module'

import { createImportPath, ensureGeneratedDir } from '@vite-hub/internal/build/paths'
import { writeFileIfChanged } from '@vite-hub/internal/definition-catalog'
import { detectHosting } from '@vite-hub/internal/hosting'
import { isPlainObject } from '@vite-hub/internal/object'
import { resolve } from 'pathe'

import { discoverSandboxDefinitions } from '../discovery'
import { createSandboxFeaturePlan, resolveSandboxFeatureConfig } from '../feature'
import { getSandboxFeatureProvider } from '../module-types'
import { resolveFeatureRuntimePath } from './shared/feature-runtime-path'
import type { EmittedArtifact, FeatureRuntimePlan } from './shared/runtime-artifacts'
import type { AgentSandboxConfig } from '../module-types'
import type { Alias, ConfigEnv, ResolvedConfig } from 'vite'

const SANDBOX_PACKAGE_ID = '@vite-hub/sandbox'
const SANDBOX_REGISTRY_ID = '#vitehub-sandbox-registry'
const builtinModuleSet = new Set([
  ...builtinModules,
  ...builtinModules.map(name => `node:${name}`),
])

type AliasMap = Record<string, string>
type SandboxPublicOptions = AgentSandboxConfig | false
type SandboxRuntimeConfig = {
  hosting?: string
  sandbox: AgentSandboxConfig | false
}
type SandboxViteContext = {
  rootDir: string
  config: AgentSandboxConfig | false
  deps: Record<string, string>
  runtimeConfig: SandboxRuntimeConfig
  hosting?: string
  command: ConfigEnv['command']
  mode: string
}

function normalizeSandboxOptions(options: SandboxPublicOptions): AgentSandboxConfig | false {
  if (options === false)
    return false
  if (!isPlainObject(options))
    throw new TypeError('[vitehub] `sandbox` must be a plain object.')
  return { ...options } as AgentSandboxConfig
}

function createSandboxRuntimeConfig(config: AgentSandboxConfig | false, hosting?: string): SandboxRuntimeConfig {
  const provider = getSandboxFeatureProvider(config)
  const sandbox = provider?.provider === 'vercel'
    ? {
        ...config,
        token: provider.token ?? '',
        teamId: provider.teamId ?? '',
        projectId: provider.projectId ?? '',
      }
    : config

  return {
    ...(hosting ? { hosting } : {}),
    sandbox,
  }
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
  hasDefinitions: boolean,
): Promise<SandboxViteContext> {
  const configOptions = userConfig.sandbox as SandboxPublicOptions | undefined
  const options = normalizeSandboxOptions(
    typeof configOptions === 'undefined' ? integrationOptions ?? {} : configOptions,
  )
  const nitro = isPlainObject(userConfig.nitro) ? userConfig.nitro : {}
  const preset = typeof userConfig.preset === 'string'
    ? userConfig.preset
    : typeof nitro.preset === 'string'
      ? nitro.preset
      : process.env.NITRO_PRESET || process.env.SERVER_PRESET
  const hosting = detectHosting({ options: { preset } }) || undefined
  const config = options === false
    ? false
    : hasDefinitions
      ? resolveSandboxFeatureConfig(options, hosting)
      : { ...options }
  const runtimeSandboxConfig = config !== false
    && (hasDefinitions || getSandboxFeatureProvider(config)?.provider)
    ? config
    : false
  const rootDir = resolve(process.cwd(), typeof userConfig.root === 'string' ? userConfig.root : '.')

  return {
    rootDir,
    config,
    deps: hasDefinitions ? await readSandboxWorkspaceDeps(rootDir) : {},
    runtimeConfig: createSandboxRuntimeConfig(runtimeSandboxConfig, hosting),
    hosting,
    command: env.command,
    mode: env.mode,
  }
}

function createSandboxStateModuleContents(context: SandboxViteContext) {
  const state = {
    config: context.config,
    runtimeConfig: context.runtimeConfig,
    hosting: context.hosting,
    rootDir: context.rootDir,
    mode: context.mode,
    command: context.command,
  }

  return [
    `const state = ${JSON.stringify(state, null, 2)}`,
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

function readAliasEntries(alias: unknown): Alias[] {
  if (Array.isArray(alias))
    return alias as Alias[]
  if (!alias || typeof alias !== 'object')
    return []

  return Object.entries(alias as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([find, replacement]) => ({ find, replacement }))
}

function resolveStringAliases(alias: unknown): AliasMap {
  const aliases: AliasMap = {}
  for (const entry of readAliasEntries(alias)) {
    if (typeof entry.find !== 'string' || typeof entry.replacement !== 'string')
      continue
    const find = entry.find.replace(/\/$/, '')
    if (builtinModuleSet.has(entry.find) || builtinModuleSet.has(find))
      continue
    if (!find)
      continue
    aliases[find] = entry.replacement
  }
  return aliases
}

function readResolveOptions(config: unknown): { alias?: unknown } {
  if (!config || typeof config !== 'object' || !('resolve' in config))
    return {}

  const resolveOptions = (config as { resolve?: unknown }).resolve
  return resolveOptions && typeof resolveOptions === 'object'
    ? resolveOptions as { alias?: unknown }
    : {}
}

function createSandboxRuntimeFacadeContents(file: string, runtimeConfig: AgentSandboxConfig | false, registryFile: string) {
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

  for (const artifact of plan.artifacts || []) {
    const dst = resolve(generatedDir, artifact.filename)
    const contents = artifact.contents ?? await artifact.getContents?.(emitted)
    if (typeof contents !== 'string')
      throw new Error(`[vitehub] Sandbox generated artifact "${artifact.key}" did not return contents.`)

    emitted.set(artifact.key, { ...artifact, contents, dst })
  }

  await rm(resolve(generatedDir, 'runtime/sandbox-definitions'), { recursive: true, force: true })
  if (typeTemplate)
    await writeFileIfChanged(resolve(generatedDir, typeTemplate.filename), typeTemplate.contents)
  for (const artifact of emitted.values())
    await writeFileIfChanged(artifact.dst, artifact.contents)

  return emitted
}

export async function prepareSandboxRuntime(options: {
  integrationOptions?: SandboxPublicOptions
  userConfig: Record<string, unknown>
  env: ConfigEnv
  resolvedConfig?: ResolvedConfig
  writeArtifacts?: boolean
}) {
  const rootDir = options.resolvedConfig?.root || resolve(process.cwd(), typeof options.userConfig.root === 'string' ? options.userConfig.root : '.')
  const configOptions = options.userConfig.sandbox as SandboxPublicOptions | undefined
  const disabled = typeof configOptions === 'undefined'
    ? options.integrationOptions === false
    : configOptions === false
  const definitions = disabled ? [] : discoverSandboxDefinitions({ rootDir })
  const resolvedNitro = (options.resolvedConfig as { nitro?: unknown } | undefined)?.nitro
  const context = await resolveSandboxViteContext(options.integrationOptions, {
    ...options.userConfig,
    ...(isPlainObject(resolvedNitro) ? { nitro: resolvedNitro } : {}),
    root: rootDir,
  }, options.env, definitions.length > 0)
  const stateModule = createSandboxStateModuleContents(context)
  if (!context.config) {
    return {
      aliases: {} as AliasMap,
      definitions: [],
      files: [],
      hosting: context.hosting,
      provider: undefined,
      stateModule,
    }
  }

  const facadeFile = resolve(ensureGeneratedDir(rootDir, 'sandbox'), 'runtime/sandbox.mjs')
  const plan = await createSandboxFeaturePlan(
    context.config,
    definitions,
    { aliasPath: facadeFile },
    context.deps,
    context.hosting,
    {
      bundleAlias: resolveStringAliases(options.resolvedConfig?.resolve.alias ?? readResolveOptions(options.userConfig).alias),
      rootDir,
      scanRoots: [rootDir],
      serverImports: { presets: [] },
    },
  )
  const aliases = createGeneratedAliasMap(rootDir, plan)
  if (options.writeArtifacts === false) {
    return {
      aliases,
      cloudflare: plan.cloudflare,
      definitions,
      files: [],
      hosting: context.hosting,
      provider: getSandboxFeatureProvider(context.config)?.provider,
      stateModule,
    }
  }

  const emitted = await writeSandboxArtifacts(rootDir, plan)
  await writeFileIfChanged(
    facadeFile,
    createSandboxRuntimeFacadeContents(
      facadeFile,
      context.runtimeConfig.sandbox,
      aliases[SANDBOX_REGISTRY_ID]!,
    ),
  )
  return {
    aliases,
    cloudflare: plan.cloudflare,
    definitions,
    files: [facadeFile, ...Array.from(emitted.values(), artifact => artifact.dst)],
    hosting: context.hosting,
    provider: getSandboxFeatureProvider(context.config)?.provider,
    stateModule,
  }
}
