import { mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink } from 'node:fs/promises'
import { builtinModules } from 'node:module'

import { createImportPath, ensureGeneratedDir } from '@vite-hub/internal/build/paths'
import { VITEHUB_PROJECT_ROOT } from '@vite-hub/internal/build/vite'
import { writeFileIfChanged } from '@vite-hub/internal/definition-catalog'
import { detectHosting } from '@vite-hub/internal/hosting'
import { isPlainObject } from '@vite-hub/internal/object'
import { basename, dirname, resolve } from 'pathe'

import { discoverSandboxTaskDefinitions } from '../discovery'
import { createSandboxTaskFeaturePlan, resolveSandboxTaskFeatureConfig, sandboxTaskRuntimeSpecifier, sandboxTaskRuntimeStateSpecifier } from '../feature'
import { getSandboxTaskFeatureProvider } from '../module-types'
import {
  activateSandboxTaskRuntimeFile,
  markSandboxTaskRuntimeGeneration,
  pruneSandboxTaskRuntimeGeneration,
  readSandboxTaskRuntimeGeneration,
  restoreSandboxTaskRuntimeGeneration,
  resolveSandboxTaskRuntimeFacadeImportBase,
  resolveSandboxTaskRuntimeLinkType,
  type SandboxTaskRuntimeGenerationLease,
  withSandboxTaskRuntimeGenerationLock,
} from './runtime-generation'
import type { EmittedArtifact, FeatureRuntimePlan } from './shared/runtime-artifacts'
import type { AgentSandboxTaskConfig } from '../module-types'
import type { Alias, ConfigEnv, ResolvedConfig } from 'vite'
import { sandboxTaskErrorDiagnostics } from "../error-diagnostics.ts"

const SANDBOX_PACKAGE_ID = '@vite-hub/sandbox-task'
const SANDBOX_REGISTRY_ID = '#vitehub-sandbox-task-registry'
const builtinModuleSet = new Set([
  ...builtinModules,
  ...builtinModules.map(name => `node:${name}`),
])

type AliasMap = Record<string, string>
type SandboxTaskPublicOptions = AgentSandboxTaskConfig | false
type SandboxTaskRuntimeConfig = {
  hosting?: string
  sandboxTask: AgentSandboxTaskConfig | false
}
type SandboxTaskViteContext = {
  rootDir: string
  config: AgentSandboxTaskConfig | false
  deps: Record<string, string>
  runtimeConfig: SandboxTaskRuntimeConfig
  hosting?: string
  command: ConfigEnv['command']
  mode: string
}

function readNodeErrorCode(error: unknown) {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

function normalizeSandboxTaskOptions(options: SandboxTaskPublicOptions): AgentSandboxTaskConfig | false {
  if (options === false)
    return false
  if (!isPlainObject(options))
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0042({ message: '[vitehub] `sandboxTask` must be a plain object.' })
  return { ...options } as AgentSandboxTaskConfig
}

function createSandboxTaskRuntimeConfig(config: AgentSandboxTaskConfig | false, hosting?: string): SandboxTaskRuntimeConfig {
  const provider = getSandboxTaskFeatureProvider(config)
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
    sandboxTask: sandbox,
  }
}

async function readSandboxTaskWorkspaceDeps(rootDir: string) {
  const packageJson = JSON.parse(await readFile(resolve(rootDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  return {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  }
}

async function resolveSandboxTaskViteContext(
  integrationOptions: SandboxTaskPublicOptions | undefined,
  userConfig: Record<string, unknown>,
  env: ConfigEnv,
  hasDefinitions: boolean,
): Promise<SandboxTaskViteContext> {
  const configOptions = userConfig.sandboxTask as SandboxTaskPublicOptions | undefined
  const options = normalizeSandboxTaskOptions(
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
      ? resolveSandboxTaskFeatureConfig(options, hosting)
      : { ...options }
  const runtimeSandboxTaskConfig = config !== false
    && (hasDefinitions || getSandboxTaskFeatureProvider(config)?.provider)
    ? config
    : false
  const rootDir = resolve(process.cwd(), typeof userConfig.root === 'string' ? userConfig.root : '.')

  return {
    rootDir,
    config,
    deps: hasDefinitions ? await readSandboxTaskWorkspaceDeps(rootDir) : {},
    runtimeConfig: createSandboxTaskRuntimeConfig(runtimeSandboxTaskConfig, hosting),
    hosting,
    command: env.command,
    mode: env.mode,
  }
}

function createSandboxTaskStateModuleContents(context: SandboxTaskViteContext) {
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

function createSandboxTaskRuntimeFacadeContents(
  file: string,
  runtimeConfig: AgentSandboxTaskConfig | false,
  registryFile: string,
  providerLoaderFile?: string,
) {
  return [
    `import sandboxTaskRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    ...(providerLoaderFile
      ? [`export { loadSandboxTaskRuntimeProvider } from ${JSON.stringify(createImportPath(file, providerLoaderFile))}`]
      : []),
    `import { setSandboxTaskRuntimeConfig, setSandboxTaskRuntimeRegistry } from ${JSON.stringify(sandboxTaskRuntimeStateSpecifier)}`,
    '',
    `setSandboxTaskRuntimeConfig(${JSON.stringify(runtimeConfig, null, 2)})`,
    'setSandboxTaskRuntimeRegistry(sandboxTaskRegistry)',
    '',
    'export default sandboxTaskRegistry',
    `export * from ${JSON.stringify(sandboxTaskRuntimeSpecifier)}`,
    '',
  ].join('\n')
}

function createGeneratedAliasMap(rootDir: string, plan: FeatureRuntimePlan, platform = process.platform): AliasMap {
  const generatedDir = ensureGeneratedDir(rootDir, 'sandbox-task')
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

async function writeSandboxTaskArtifacts(
  rootDir: string,
  plan: FeatureRuntimePlan,
  createFacadeContents: (file: string, registryFile: string, providerLoaderFile?: string) => string,
  platform = process.platform,
) {
  const generatedDir = ensureGeneratedDir(rootDir, 'sandbox-task')
  await mkdir(generatedDir, { recursive: true })
  return await withSandboxTaskRuntimeGenerationLock(generatedDir, async lease => await writeSandboxTaskArtifactsLocked(
    plan,
    createFacadeContents,
    generatedDir,
    platform,
    lease,
  ))
}

async function writeSandboxTaskArtifactsLocked(
  plan: FeatureRuntimePlan,
  createFacadeContents: (file: string, registryFile: string, providerLoaderFile?: string) => string,
  generatedDir: string,
  platform: NodeJS.Platform,
  lease: SandboxTaskRuntimeGenerationLease,
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
    ? await readSandboxTaskRuntimeGeneration(resolve(runtimeDir, 'sandbox-task.mjs'), generationsDir)
    : undefined

  try {
    for (const artifact of plan.artifacts || []) {
      const stableDst = resolve(generatedDir, artifact.filename)
      const relativePath = stableDst.slice(runtimeDir.length + 1)
      const dst = resolve(generationDir, relativePath)
      const contents = artifact.contents ?? await artifact.getContents?.(emitted, { dst, stableDst })
      if (typeof contents !== 'string')
        throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0043({ message: `[vitehub] Sandbox generated artifact "${artifact.key}" did not return contents.` })

      emitted.set(artifact.key, { ...artifact, contents, dst, stableDst })
    }

    if (typeTemplate)
      await writeFileIfChanged(resolve(generationDir, typeTemplate.filename.replace(/^runtime\//, '')), typeTemplate.contents)
    for (const artifact of emitted.values())
      await writeFileIfChanged(artifact.dst, artifact.contents)
    const generationFacadeFile = resolve(generationDir, 'sandbox-task.mjs')
    const activeFacadeFile = resolveSandboxTaskRuntimeFacadeImportBase(runtimeDir, generationFacadeFile, platform)
    const registryArtifact = emitted.get(plan.aliases?.find(alias => alias.key === SANDBOX_REGISTRY_ID)?.artifactKey || '')
    if (!registryArtifact)
      throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0044({ message: '[vitehub] Sandbox runtime plan did not emit a registry artifact.' })
    const providerLoaderArtifact = emitted.get('sandbox-task-provider-loader')
    await writeFileIfChanged(
      generationFacadeFile,
      markSandboxTaskRuntimeGeneration(
        createFacadeContents(activeFacadeFile, registryArtifact.dst, providerLoaderArtifact?.dst),
        generationDir,
      ),
    )
    await lease.assertOwned()
    if (platform === 'win32') {
      await lease.publish(async () => {
        await lease.assertOwned()
        await mkdir(runtimeDir, { recursive: true })
        const stableDefinitions = [...emitted.values()].filter(artifact => artifact.key.startsWith('sandbox-task-definition:'))
        for (const artifact of stableDefinitions) {
          await lease.assertOwned()
          await mkdir(dirname(artifact.stableDst), { recursive: true })
          const stagedDefinition = resolve(
            generatedDir,
            `.runtime-definition-${generationDir.slice(generationsDir.length + 1)}-${basename(artifact.stableDst)}`,
          )
          await activateSandboxTaskRuntimeFile(artifact.dst, artifact.stableDst, stagedDefinition)
        }
        if (typeTemplate) {
          await lease.assertOwned()
          const relativePath = typeTemplate.filename.replace(/^runtime\//, '')
          const stagedType = resolve(generatedDir, `.runtime-types-${generationDir.slice(generationsDir.length + 1)}.d.ts`)
          await activateSandboxTaskRuntimeFile(
            resolve(generationDir, relativePath),
            resolve(runtimeDir, relativePath),
            stagedType,
          )
        }
        await lease.assertOwned()
        const stagedFacade = resolve(generatedDir, `.runtime-facade-${generationDir.slice(generationsDir.length + 1)}.mjs`)
        await activateSandboxTaskRuntimeFile(generationFacadeFile, resolve(runtimeDir, 'sandbox-task.mjs'), stagedFacade)
        activated = true
        const stableDefinitionDir = resolve(runtimeDir, 'sandbox-task-definitions')
        const retainedDefinitions = new Set(stableDefinitions.map(artifact => artifact.stableDst))
        for (const entry of await readdir(stableDefinitionDir).catch(() => [])) {
          const path = resolve(stableDefinitionDir, entry)
          if (!retainedDefinitions.has(path)) {
            await lease.assertOwned()
            await pruneSandboxTaskRuntimeGeneration(path)
          }
        }
      })
    }
    else {
      await lease.publish(async () => {
        await lease.assertOwned()
        await symlink(generationDir, stagedLink, resolveSandboxTaskRuntimeLinkType(platform))
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
              await restoreSandboxTaskRuntimeGeneration(legacyRuntimeDir, runtimeDir, lease)
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
          await pruneSandboxTaskRuntimeGeneration(legacyRuntimeDir)
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
        await pruneSandboxTaskRuntimeGeneration(path)
      }
    }
  })

  return emitted
}

export async function prepareSandboxTaskRuntime(options: {
  integrationOptions?: SandboxTaskPublicOptions
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
  const configOptions = options.userConfig.sandboxTask as SandboxTaskPublicOptions | undefined
  const disabled = typeof configOptions === 'undefined'
    ? options.integrationOptions === false
    : configOptions === false
  const definitions = disabled ? [] : discoverSandboxTaskDefinitions({ rootDir })
  const resolvedNitro = (options.resolvedConfig as { nitro?: unknown } | undefined)?.nitro
  const context = await resolveSandboxTaskViteContext(options.integrationOptions, {
    ...options.userConfig,
    ...(isPlainObject(resolvedNitro) ? { nitro: resolvedNitro } : {}),
    root: rootDir,
  }, options.env, definitions.length > 0)
  const stateModule = createSandboxTaskStateModuleContents(context)
  if (!context.config) {
    return {
      aliases: {} as AliasMap,
      definitions: [],
      files: [],
      hosting: context.hosting,
      provider: undefined,
      rootDir,
      stateModule,
      watchFiles: [],
    }
  }

  const facadeFile = resolve(ensureGeneratedDir(rootDir, 'sandbox-task'), 'runtime/sandbox-task.mjs')
  const plan = await createSandboxTaskFeaturePlan(
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
      provider: getSandboxTaskFeatureProvider(context.config)?.provider,
      rootDir,
      stateModule,
      watchFiles: plan.watchFiles || [],
    }
  }

  const emitted = await writeSandboxTaskArtifacts(
    rootDir,
    plan,
    (file, registryFile, providerLoaderFile) => createSandboxTaskRuntimeFacadeContents(
      file,
      context.runtimeConfig.sandboxTask,
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
      ...(plan.artifacts || []).map(artifact => resolve(ensureGeneratedDir(rootDir, 'sandbox-task'), artifact.filename)),
    ],
    hosting: context.hosting,
    provider: getSandboxTaskFeatureProvider(context.config)?.provider,
    rootDir,
    stateModule,
    watchFiles: plan.watchFiles || [],
  }
}
