import { buildFeatureViteContext } from '@vite-hub/internal/feature-bridge'
import { createImportPath, ensureGeneratedDir } from '@vite-hub/internal/build/paths'
import { createNoExternalMerger, isServerEnvironment } from '@vite-hub/internal/build/vite'
import { writeFileIfChanged } from '@vite-hub/internal/definition-catalog'
import { resolve } from 'pathe'

import { createFeatureVitePlugin } from './internal/shared/vite'
import { resolveFeatureRuntimePath } from './internal/shared/feature-runtime-path'
import { discoverSandboxDefinitions } from './discovery'
import { createSandboxFeaturePlan } from './feature'
import { sandboxFeatureEngine, type SandboxPublicOptions } from './integration'
import type { AgentSandboxConfig } from './module-types'
import type { EmittedArtifact, FeatureRuntimePlan } from './internal/shared/runtime-artifacts'
import type { Alias, AliasOptions, ConfigEnv, Plugin, ResolvedConfig } from 'vite'

export { createViteHubDefinitionAutoImportsPlugin } from './internal/shared/vitehub-auto-imports'
export type { SandboxPublicOptions } from './integration'

export type SandboxVitePlugin = Plugin

const SANDBOX_PACKAGE_ID = '@vite-hub/sandbox'
const SANDBOX_PROVIDER_LOADER_ID = 'vitehub-sandbox-provider-loader'
const SANDBOX_REGISTRY_ID = '#vitehub-sandbox-registry'

type AliasMap = Record<string, string>
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
): Promise<AliasMap> {
  const rootDir = resolved?.root || resolve(process.cwd(), typeof rawConfig.root === 'string' ? rawConfig.root : '.')
  const context = await buildFeatureViteContext(engine, { ...rawConfig, root: rootDir }, rawEnv)
  const sandboxConfig = context?.config as AgentSandboxConfig | false | undefined
  if (!context || !sandboxConfig)
    return {}

  const facadeFile = resolve(ensureGeneratedDir(rootDir, 'sandbox'), 'runtime/sandbox.mjs')
  const definitions = discoverSandboxDefinitions({ rootDir })
  const plan = await createSandboxFeaturePlan(
    sandboxConfig,
    definitions,
    { aliasPath: facadeFile },
    context.deps,
    context.hosting,
  )
  const aliases = createGeneratedAliasMap(rootDir, plan)
  await writeSandboxArtifacts(rootDir, plan)
  await writeFileIfChanged(
    facadeFile,
    createSandboxRuntimeFacadeContents(
      facadeFile,
      (context.runtimeConfig as { sandbox?: unknown }).sandbox ?? context.config,
      aliases[SANDBOX_REGISTRY_ID]!,
    ),
  )
  return aliases
}

export function hubSandbox(options?: SandboxPublicOptions): SandboxVitePlugin {
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
  let rawConfig: Record<string, unknown> = {}
  let rawEnv: ConfigEnv = { command: 'serve', mode: 'development' }
  let resolvedConfig: ResolvedConfig | undefined
  return {
    ...plugin,
    async config(config, env) {
      rawConfig = config as Record<string, unknown>
      rawEnv = env
      const result = typeof configHook === 'function'
        ? await configHook.call(this, config, env)
        : undefined
      generatedAliases = await prepareSandboxRuntimeAliases(engine, rawConfig, rawEnv, resolvedConfig)
      return {
        ...(result && typeof result === 'object' ? result : {}),
        resolve: {
          ...readResolveOptions(result),
          alias: mergeAliases(readResolveOptions(result).alias, {
            [SANDBOX_PROVIDER_LOADER_ID]: sandboxProviderLoaderFallback(),
            ...generatedAliases,
          }),
        },
      }
    },
    async configResolved(config) {
      resolvedConfig = config
      generatedAliases = await prepareSandboxRuntimeAliases(engine, rawConfig, rawEnv, resolvedConfig)
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
