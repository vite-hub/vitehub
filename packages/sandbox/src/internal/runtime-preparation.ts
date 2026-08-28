import { mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink } from 'node:fs/promises'
import { builtinModules } from 'node:module'

import { createImportPath, ensureGeneratedDir } from '@vite-hub/internal/build/paths'
import { VITEHUB_PROJECT_ROOT } from '@vite-hub/internal/build/vite'
import { writeFileIfChanged } from '@vite-hub/internal/definition-catalog'
import { detectHosting } from '@vite-hub/internal/hosting'
import { isPlainObject } from '@vite-hub/internal/object'
import { basename, dirname, resolve } from 'pathe'

import { discoverSandboxDefinitions } from '../discovery'
import { createSandboxFeaturePlan, resolveSandboxFeatureConfig } from '../feature'
import { getSandboxFeatureProvider } from '../module-types'
import {
  activateSandboxRuntimeFile,
  markSandboxRuntimeGeneration,
  pruneSandboxRuntimeGeneration,
  readSandboxRuntimeGeneration,
  restoreSandboxRuntimeGeneration,
  resolveSandboxRuntimeFacadeImportBase,
  resolveSandboxRuntimeLinkType,
  type SandboxRuntimeGenerationLease,
  withSandboxRuntimeGenerationLock,
} from './runtime-generation'
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

function readNodeErrorCode(error: unknown) {
  return error instanceof Error && 'code' in error ? error.code : undefined
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

function createSandboxRuntimeFacadeContents(
  file: string,
  runtimeConfig: AgentSandboxConfig | false,
  registryFile: string,
  providerLoaderFile?: string,
) {
  const stateFile = resolveFeatureRuntimePath(import.meta.url, SANDBOX_PACKAGE_ID, './runtime/state', 'runtime/state.js')
  const packageIndexFile = resolveFeatureRuntimePath(import.meta.url, SANDBOX_PACKAGE_ID, './index', 'index.js')

  return [
    `import sandboxRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    ...(providerLoaderFile
      ? [`export { loadSandboxRuntimeProvider } from ${JSON.stringify(createImportPath(file, providerLoaderFile))}`]
      : []),
    `import { setSandboxRuntimeConfig, setSandboxRuntimeRegistry } from ${JSON.stringify(createImportPath(file, stateFile))}`,
    '',
    `setSandboxRuntimeConfig(${JSON.stringify(runtimeConfig, null, 2)})`,
    'setSandboxRuntimeRegistry(sandboxRegistry)',
    '',
    'export default sandboxRegistry',
    `export * from ${JSON.stringify(createImportPath(file, packageIndexFile))}`,
    '',
  ].join('\n')
}

function createGeneratedAliasMap(rootDir: string, plan: FeatureRuntimePlan, platform = process.platform): AliasMap {
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
    if (platform === 'win32' && alias.artifactKey) {
      // One replaceable file keeps every runtime entry on the same immutable generation.
      aliases[alias.key] = plan.manifest.aliasPath
      continue
    }
    if (alias.artifactKey && artifactPaths.has(alias.artifactKey))
      aliases[alias.key] = artifactPaths.get(alias.artifactKey)!
  }

  return aliases
}

async function writeSandboxArtifacts(
  rootDir: string,
  plan: FeatureRuntimePlan,
  createFacadeContents: (file: string, registryFile: string, providerLoaderFile?: string) => string,
  platform = process.platform,
) {
  const generatedDir = ensureGeneratedDir(rootDir, 'sandbox')
  await mkdir(generatedDir, { recursive: true })
  return await withSandboxRuntimeGenerationLock(generatedDir, async lease => await writeSandboxArtifactsLocked(
    plan,
    createFacadeContents,
    generatedDir,
    platform,
    lease,
  ))
}

async function writeSandboxArtifactsLocked(
  plan: FeatureRuntimePlan,
  createFacadeContents: (file: string, registryFile: string, providerLoaderFile?: string) => string,
  generatedDir: string,
  platform: NodeJS.Platform,
  lease: SandboxRuntimeGenerationLease,
) {
  const generationsDir = resolve(generatedDir, '.runtime-generations')
  await mkdir(generationsDir, { recursive: true })
  const generationDir = await mkdtemp(resolve(generationsDir, 'runtime-'))
  const runtimeDir = resolve(generatedDir, 'runtime')
  const stagedLink = resolve(generatedDir, `.runtime-link-${generationDir.slice(generationsDir.length + 1)}`)
  const legacyRuntimeDir = resolve(generationsDir, `.legacy-${generationDir.slice(generationsDir.length + 1)}`)
  const emitted = new Map<string, EmittedArtifact>()
  const typeTemplate = plan.manifest.typeTemplate
  let activated = false
  const previousGeneration = await readlink(runtimeDir).catch(() => undefined)
  const previousWindowsGeneration = platform === 'win32'
    ? await readSandboxRuntimeGeneration(resolve(runtimeDir, 'sandbox.mjs'), generationsDir)
    : undefined

  try {
    for (const artifact of plan.artifacts || []) {
      const stableDst = resolve(generatedDir, artifact.filename)
      const relativePath = stableDst.slice(runtimeDir.length + 1)
      const dst = resolve(generationDir, relativePath)
      const contents = artifact.contents ?? await artifact.getContents?.(emitted, { dst, stableDst })
      if (typeof contents !== 'string')
        throw new Error(`[vitehub] Sandbox generated artifact "${artifact.key}" did not return contents.`)

      emitted.set(artifact.key, { ...artifact, contents, dst, stableDst })
    }

    if (typeTemplate)
      await writeFileIfChanged(resolve(generationDir, typeTemplate.filename.replace(/^runtime\//, '')), typeTemplate.contents)
    for (const artifact of emitted.values())
      await writeFileIfChanged(artifact.dst, artifact.contents)
    const generationFacadeFile = resolve(generationDir, 'sandbox.mjs')
    const activeFacadeFile = resolveSandboxRuntimeFacadeImportBase(runtimeDir, generationFacadeFile, platform)
    const registryArtifact = emitted.get(plan.aliases?.find(alias => alias.key === SANDBOX_REGISTRY_ID)?.artifactKey || '')
    if (!registryArtifact)
      throw new Error('[vitehub] Sandbox runtime plan did not emit a registry artifact.')
    const providerLoaderArtifact = emitted.get('sandbox-provider-loader')
    await writeFileIfChanged(
      generationFacadeFile,
      markSandboxRuntimeGeneration(
        createFacadeContents(activeFacadeFile, registryArtifact.dst, providerLoaderArtifact?.dst),
        generationDir,
      ),
    )
    await lease.assertOwned()
    if (platform === 'win32') {
      await lease.publish(async () => {
        await lease.assertOwned()
        await mkdir(runtimeDir, { recursive: true })
        const stableDefinitions = [...emitted.values()].filter(artifact => artifact.key.startsWith('sandbox-definition:'))
        for (const artifact of stableDefinitions) {
          await lease.assertOwned()
          await mkdir(dirname(artifact.stableDst), { recursive: true })
          const stagedDefinition = resolve(
            generatedDir,
            `.runtime-definition-${generationDir.slice(generationsDir.length + 1)}-${basename(artifact.stableDst)}`,
          )
          await activateSandboxRuntimeFile(artifact.dst, artifact.stableDst, stagedDefinition)
        }
        if (typeTemplate) {
          await lease.assertOwned()
          const relativePath = typeTemplate.filename.replace(/^runtime\//, '')
          const stagedType = resolve(generatedDir, `.runtime-types-${generationDir.slice(generationsDir.length + 1)}.d.ts`)
          await activateSandboxRuntimeFile(
            resolve(generationDir, relativePath),
            resolve(runtimeDir, relativePath),
            stagedType,
          )
        }
        await lease.assertOwned()
        const stagedFacade = resolve(generatedDir, `.runtime-facade-${generationDir.slice(generationsDir.length + 1)}.mjs`)
        await activateSandboxRuntimeFile(generationFacadeFile, resolve(runtimeDir, 'sandbox.mjs'), stagedFacade)
        activated = true
        const stableDefinitionDir = resolve(runtimeDir, 'sandbox-definitions')
        const retainedDefinitions = new Set(stableDefinitions.map(artifact => artifact.stableDst))
        for (const entry of await readdir(stableDefinitionDir).catch(() => [])) {
          const path = resolve(stableDefinitionDir, entry)
          if (!retainedDefinitions.has(path)) {
            await lease.assertOwned()
            await pruneSandboxRuntimeGeneration(path)
          }
        }
      })
    }
    else {
      await lease.publish(async () => {
        await lease.assertOwned()
        await symlink(generationDir, stagedLink, resolveSandboxRuntimeLinkType(platform))
        await lease.assertOwned()

        try {
          await rename(stagedLink, runtimeDir)
          activated = true
        }
        catch (error) {
          const code = readNodeErrorCode(error)
          if (code !== 'EEXIST' && code !== 'EISDIR' && code !== 'ENOTEMPTY')
            throw error

          await lease.assertOwned()
          await rename(runtimeDir, legacyRuntimeDir)
          try {
            await lease.assertOwned()
            await rename(stagedLink, runtimeDir)
            activated = true
          }
          catch (activationError) {
            try {
              await restoreSandboxRuntimeGeneration(legacyRuntimeDir, runtimeDir, lease)
            }
            catch (rollbackError) {
              throw new AggregateError(
                [activationError, rollbackError],
                `[vitehub] Sandbox runtime activation failed; the previous runtime is retained at ${legacyRuntimeDir}.`,
              )
            }
            throw activationError
          }
          await lease.assertOwned()
          await pruneSandboxRuntimeGeneration(legacyRuntimeDir)
        }
      })
    }
  }
  finally {
    await rm(stagedLink, { force: true })
    if (!activated)
      await rm(generationDir, { recursive: true, force: true })
  }

  const retained = new Set([
    generationDir,
    previousGeneration && resolve(generatedDir, previousGeneration),
    previousWindowsGeneration,
  ].filter(Boolean))
  await lease.publish(async () => {
    await lease.assertOwned()
    for (const entry of await readdir(generationsDir)) {
      const path = resolve(generationsDir, entry)
      if (!retained.has(path)) {
        await lease.assertOwned()
        await pruneSandboxRuntimeGeneration(path)
      }
    }
  })

  return emitted
}

export async function prepareSandboxRuntime(options: {
  integrationOptions?: SandboxPublicOptions
  userConfig: Record<string, unknown>
  env: ConfigEnv
  resolvedConfig?: ResolvedConfig
  platform?: NodeJS.Platform
  writeArtifacts?: boolean
}) {
  const resolvedRoot = options.resolvedConfig?.root || resolve(process.cwd(), typeof options.userConfig.root === 'string' ? options.userConfig.root : '.')
  const configuredProjectRoot = options.userConfig[VITEHUB_PROJECT_ROOT]
  const rootDir = typeof configuredProjectRoot === 'string'
    ? resolve(configuredProjectRoot)
    : resolvedRoot
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
      rootDir,
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
  const aliases = createGeneratedAliasMap(rootDir, plan, options.platform)
  if (options.writeArtifacts === false) {
    return {
      aliases,
      cloudflare: plan.cloudflare,
      definitions,
      files: [],
      hosting: context.hosting,
      provider: getSandboxFeatureProvider(context.config)?.provider,
      rootDir,
      stateModule,
    }
  }

  const emitted = await writeSandboxArtifacts(
    rootDir,
    plan,
    (file, registryFile, providerLoaderFile) => createSandboxRuntimeFacadeContents(
      file,
      context.runtimeConfig.sandbox,
      registryFile,
      providerLoaderFile,
    ),
    options.platform,
  )
  return {
    aliases,
    cloudflare: plan.cloudflare,
    definitions,
    files: [
      facadeFile,
      ...Array.from(emitted.values(), artifact => artifact.dst),
      ...(plan.artifacts || []).map(artifact => resolve(ensureGeneratedDir(rootDir, 'sandbox'), artifact.filename)),
    ],
    hosting: context.hosting,
    provider: getSandboxFeatureProvider(context.config)?.provider,
    rootDir,
    stateModule,
  }
}
