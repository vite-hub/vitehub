import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createImportPath, generatedDirSegments } from '@vitehub/internal/build/paths'
import { resolveRuntimeEntry as resolveEntry } from '@vitehub/internal/nitro'
import { createRuntimeRegistryContents, sanitizeDefinitionFilename, writeFileIfChanged } from '@vitehub/internal/definition-discovery'
import { readPackageJSON } from 'pkg-types'
import type { Nitro, NitroModule, NitroRuntimeConfig } from 'nitro/types'
import {
  configureCloudflareSandbox,
  defaultCloudflareSandboxBinding,
  defaultCloudflareSandboxClassName,
  defaultCloudflareSandboxMigrationTag,
  installCloudflareSandboxEntrypoint,
  writeCloudflareSandboxDockerfile,
} from '../cloudflare'
import { extractSandboxDefinitionOptions } from '../definition-options'
import { discoverNitroSandboxDefinitions } from '../discovery'
import { createSandboxProviderLoaderContents, resolveSandboxProviderLoaderTarget, sandboxRuntimeDependencies, sandboxRuntimeDependencyByProvider } from '../feature'
import { hasInstalledDependency } from '../internal/shared/dependency'
import { createDiscoveredDefinitionCompiler } from '../internal/shared/discovered-definition'
import { resolveEffectiveViteHubServerImports } from '../internal/shared/vitehub-server-imports'
import { getSupportedHostingProvider } from '../internal/shared/hosting'
import { applyServerImportsToNitro } from '../internal/shared/server-imports'
import { ensureNitroImports } from '../internal/shared/nitro-imports'
import { tryResolveModule } from '../internal/shared/module-resolve'
import { normalizeSandboxPublicOptions } from '../integration'
import { getSandboxFeatureProvider } from '../module-types'
import type { AgentSandboxConfig, SandboxDefinitionOptions } from '../module-types'
import { bundleSandboxDefinition } from '../bundle'

function resolveRuntimeEntry(srcRelative: string, packageSubpath: string): string {
  return resolveEntry(srcRelative, packageSubpath, import.meta.url)
}

function resolveNitroSandboxScanDirs(rootDir: string, scanDirs: string[] | undefined) {
  return scanDirs?.length ? scanDirs : [resolve(rootDir, 'server')]
}

function resolveSandboxConfig(config: AgentSandboxConfig, hosting?: string): AgentSandboxConfig {
  const provider = getSandboxFeatureProvider(config)
  if (provider?.provider)
    return { ...config }

  const inferred = getSupportedHostingProvider(hosting, ['cloudflare', 'vercel'])
  if (!inferred)
    return { ...config }

  return {
    ...config,
    provider: inferred,
  } as AgentSandboxConfig
}

function assignSandboxRuntimeConfig(runtimeConfig: Record<string, unknown>, config: AgentSandboxConfig) {
  const provider = getSandboxFeatureProvider(config)
  if (provider?.provider === 'vercel') {
    runtimeConfig.sandbox = {
      ...config,
      token: provider.token ?? '',
      teamId: provider.teamId ?? '',
      projectId: provider.projectId ?? '',
    } as AgentSandboxConfig
    return
  }

  runtimeConfig.sandbox = config
}

async function readWorkspaceDeps(rootDir: string) {
  const packageJson = await readPackageJSON(rootDir)
  return {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  }
}

const sandboxGeneratedDir = generatedDirSegments('sandbox')

function createNitroSandboxRegistryPath(rootDir: string, buildDir: string) {
  return resolve(rootDir, buildDir, ...sandboxGeneratedDir, 'nitro-registry.mjs')
}

function createNitroSandboxPluginPath(rootDir: string, buildDir: string) {
  return resolve(rootDir, buildDir, ...sandboxGeneratedDir, 'nitro-plugin.ts')
}

function createNitroSandboxDefinitionPath(rootDir: string, buildDir: string, name: string) {
  return resolve(rootDir, buildDir, ...sandboxGeneratedDir, 'definitions', `${sanitizeDefinitionFilename(name)}.mjs`)
}

function createNitroSandboxPluginContents(file: string, registryFile: string) {
  return [
    'import { definePlugin as defineNitroPlugin } from "nitro"',
    'import { useRuntimeConfig } from "nitro/runtime-config"',
    'import type { AgentSandboxConfig } from "@vitehub/sandbox"',
    'import { setSandboxRuntimeConfig, setSandboxRuntimeRegistry } from "@vitehub/sandbox/runtime/state"',
    '',
    `import sandboxRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    '',
    'const sandboxNitroPlugin: ReturnType<typeof defineNitroPlugin> = defineNitroPlugin((nitroApp: any) => {',
    '  const applyRuntimeState = () => {',
    '    const runtimeConfig = useRuntimeConfig() as { sandbox?: false | AgentSandboxConfig }',
    '    setSandboxRuntimeConfig(runtimeConfig.sandbox)',
    '    setSandboxRuntimeRegistry(sandboxRegistry)',
    '  }',
    '',
    '  applyRuntimeState()',
    '',
    '  nitroApp.hooks.hook("request", () => {',
    '    applyRuntimeState()',
    '  })',
    '})',
    '',
    'export default sandboxNitroPlugin',
    '',
  ].join('\n')
}

function normalizeSandboxDefinitionOptions(name: string, options: SandboxDefinitionOptions | undefined) {
  if (!options)
    return undefined

  try {
    return JSON.parse(JSON.stringify(options)) as SandboxDefinitionOptions
  }
  catch (error) {
    throw new Error(`[vitehub] Sandbox definition "${name}" options must be JSON-serializable.`, {
      cause: error,
    })
  }
}

async function createNitroSandboxDefinitionContents(
  definition: ReturnType<typeof discoverNitroSandboxDefinitions>[number],
  compiler: Awaited<ReturnType<typeof createDiscoveredDefinitionCompiler>>,
) {
  const source = await compiler.readSource(definition._meta.sourcePath)
  const bundle = await bundleSandboxDefinition(source, definition._meta.sourcePath)
  const options = normalizeSandboxDefinitionOptions(definition.name, await extractSandboxDefinitionOptions(definition.handler))

  return `export default ${JSON.stringify({ bundle, options })}\n`
}

async function writeNitroSandboxRuntimeFiles(nitro: Nitro) {
  const registryFile = createNitroSandboxRegistryPath(nitro.options.rootDir, nitro.options.buildDir)
  const pluginFile = createNitroSandboxPluginPath(nitro.options.rootDir, nitro.options.buildDir)
  const scanDirs = resolveNitroSandboxScanDirs(nitro.options.rootDir, nitro.options.scanDirs)
  const definitions = discoverNitroSandboxDefinitions(scanDirs)
  const compiler = await createDiscoveredDefinitionCompiler({
    rootDir: nitro.options.rootDir,
    scanRoots: scanDirs,
    nitroImports: nitro.options.imports,
    featureImports: resolveEffectiveViteHubServerImports(nitro.options as Record<string, any>, 'sandbox'),
  })
  const registryDefinitions: Array<{ handler: string, name: string }> = []

  await mkdir(resolve(registryFile, '..'), { recursive: true })
  await Promise.all(definitions.map(async (definition) => {
    const file = createNitroSandboxDefinitionPath(nitro.options.rootDir, nitro.options.buildDir, definition.name)
    await writeFileIfChanged(file, await createNitroSandboxDefinitionContents(definition, compiler))
    registryDefinitions.push({ handler: file, name: definition.name })
  }))

  registryDefinitions.sort((left, right) => left.name.localeCompare(right.name))
  await writeFileIfChanged(registryFile, createRuntimeRegistryContents(registryFile, registryDefinitions))
  await writeFileIfChanged(pluginFile, createNitroSandboxPluginContents(pluginFile, registryFile))

  return {
    definitions,
    pluginFile,
    registryFile,
  }
}

function createSandboxProviderLoaderAliases(nitro: Nitro, provider: 'cloudflare' | 'vercel' | undefined, deps: Record<string, string>) {
  const providerLoaderTarget = resolveSandboxProviderLoaderTarget(provider, deps)
  const keys = [
    'virtual:vitehub-sandbox-provider-loader',
    '#vitehub-sandbox-provider-loader',
  ]

  if (!providerLoaderTarget) {
    const providerLoaderPath = resolveRuntimeEntry('../runtime/provider-loader', '@vitehub/sandbox/runtime/provider-loader')
    return {
      providerLoaderTarget,
      aliases: keys.map(key => ({ key, value: providerLoaderPath })),
    }
  }

  const providerLoaderPath = resolve(nitro.options.rootDir, nitro.options.buildDir, ...sandboxGeneratedDir, 'provider-loader.mjs')
  return {
    providerLoaderTarget,
    aliases: keys.map(key => ({ key, value: providerLoaderPath })),
    providerLoaderPath,
  }
}

function addSandboxAliases(nitro: Nitro, aliases: Array<{ key: string, value: string }>) {
  nitro.options.alias ||= {}
  nitro.options.alias['@vitehub/sandbox'] = resolveRuntimeEntry('../index', '@vitehub/sandbox')
  nitro.options.alias['@vitehub/sandbox/runtime/state'] = resolveRuntimeEntry('../runtime/state', '@vitehub/sandbox/runtime/state')
  nitro.options.alias['virtual:vitehub-sandbox-registry'] = resolveRuntimeEntry('../runtime/empty-registry', '@vitehub/sandbox/runtime/empty-registry')
  nitro.options.alias['#vitehub-sandbox-registry'] = resolveRuntimeEntry('../runtime/empty-registry', '@vitehub/sandbox/runtime/empty-registry')

  for (const alias of aliases)
    nitro.options.alias[alias.key] = alias.value
}

function addSandboxImports(nitro: Nitro) {
  ensureNitroImports(nitro)
  applyServerImportsToNitro(
    nitro.options,
    resolveEffectiveViteHubServerImports(nitro.options as Record<string, any>, 'sandbox'),
  )
}

function extendSandboxNitro(nitro: Nitro, config: AgentSandboxConfig, deps: Record<string, string>, providerLoaderTarget?: 'cloudflare' | 'vercel') {
  const defaultProvider = getSandboxFeatureProvider(config)
  const cloudflareOptions = defaultProvider?.provider === 'cloudflare'
    ? {
        binding: typeof defaultProvider.binding === 'string' ? defaultProvider.binding : defaultCloudflareSandboxBinding,
        className: typeof defaultProvider.className === 'string' ? defaultProvider.className : defaultCloudflareSandboxClassName,
        migrationTag: typeof defaultProvider.migrationTag === 'string' ? defaultProvider.migrationTag : defaultCloudflareSandboxMigrationTag,
      }
    : undefined

  if (cloudflareOptions) {
    configureCloudflareSandbox(nitro.options, cloudflareOptions)
    installCloudflareSandboxEntrypoint(nitro.options, cloudflareOptions)
  }

  const nitroOptions = nitro.options as typeof nitro.options & {
    externals?: {
      inline?: string[]
      traceInclude?: string[]
    }
  }
  nitroOptions.externals ||= {}
  nitroOptions.externals.inline ||= []
  nitroOptions.externals.traceInclude ||= []

  const runtimeDependencies = providerLoaderTarget
    ? [sandboxRuntimeDependencyByProvider[providerLoaderTarget]].filter(Boolean)
    : sandboxRuntimeDependencies

  for (const dependency of runtimeDependencies) {
    if (!hasInstalledDependency(deps, dependency))
      continue

    if (dependency !== '@vercel/sandbox' && !nitroOptions.externals.inline.includes(dependency))
      nitroOptions.externals.inline.push(dependency)

    const resolved = tryResolveModule(dependency)
    if (resolved.ok && !nitroOptions.externals.traceInclude.includes(resolved.path))
      nitroOptions.externals.traceInclude.push(resolved.path)
  }

  if (cloudflareOptions) {
    nitro.hooks.hook('compiled', async () => {
      await writeCloudflareSandboxDockerfile(nitro.options.output.serverDir)
    })
  }
}

const sandboxNitroModule: NitroModule = {
  name: '@vitehub/sandbox',
  async setup(nitro) {
    const normalized = normalizeSandboxPublicOptions((nitro.options as typeof nitro.options & { sandbox?: false | AgentSandboxConfig }).sandbox ?? {})
    const runtimeConfig = (nitro.options.runtimeConfig ||= {} as NitroRuntimeConfig) as NitroRuntimeConfig & Record<string, unknown>

    if (!normalized) {
      runtimeConfig.sandbox = false
      return
    }

    const hosting = nitro.options.preset
    if (hosting)
      runtimeConfig.hosting ||= hosting

    const config = resolveSandboxConfig(normalized, hosting)
    assignSandboxRuntimeConfig(runtimeConfig, config)
    addSandboxImports(nitro)

    const deps = await readWorkspaceDeps(nitro.options.rootDir)
    let runtimeFiles = await writeNitroSandboxRuntimeFiles(nitro)
    const provider = getSandboxFeatureProvider(config)
    const providerLoader = createSandboxProviderLoaderAliases(nitro, provider?.provider, deps)
    addSandboxAliases(nitro, providerLoader.aliases)

    if (providerLoader.providerLoaderPath && providerLoader.providerLoaderTarget)
      await writeFileIfChanged(providerLoader.providerLoaderPath, createSandboxProviderLoaderContents(providerLoader.providerLoaderTarget))

    nitro.options.plugins ||= []
    if (!nitro.options.plugins.includes(runtimeFiles.pluginFile))
      nitro.options.plugins.push(runtimeFiles.pluginFile)

    extendSandboxNitro(nitro, config, deps, providerLoader.providerLoaderTarget)

    nitro.hooks.hook('build:before', async () => {
      runtimeFiles = await writeNitroSandboxRuntimeFiles(nitro)
    })
    nitro.hooks.hook('dev:reload', async () => {
      runtimeFiles = await writeNitroSandboxRuntimeFiles(nitro)
    })

    if (provider?.provider === 'vercel' && !hasInstalledDependency(deps, '@vercel/sandbox'))
      nitro.logger.warn('Install `@vercel/sandbox` for Vercel sandbox presets.')
    if (provider?.provider === 'cloudflare' && !hasInstalledDependency(deps, '@cloudflare/sandbox'))
      nitro.logger.warn('Install `@cloudflare/sandbox` for Cloudflare sandbox presets.')

    nitro.logger.info(`@vitehub/sandbox enabled with ${runtimeFiles.definitions.length} sandbox definition${runtimeFiles.definitions.length === 1 ? '' : 's'}`)
  },
}

export default sandboxNitroModule

declare module 'nitro/types' {
  interface NitroConfig {
    sandbox?: false | AgentSandboxConfig
  }

  interface NitroOptions {
    sandbox?: false | AgentSandboxConfig
  }

  interface NitroRuntimeConfig {
    hosting?: string
    sandbox?: false | AgentSandboxConfig
  }
}
