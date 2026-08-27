import { deploymentPresetFromNitro } from '@vite-hub/internal/deployment'
import { getSupportedHostingProvider } from '@vite-hub/internal/hosting'
import { createDiscoveredDefinitionCompiler, type DiscoveredDefinitionCompilerOptions } from './internal/shared/discovered-definition'
import { toTemplateSafeName } from './internal/shared/feature-definitions'
import { resolveFeatureRuntimePath } from './internal/shared/feature-runtime-path'
import type { FeatureManifest, FeatureRuntimePlan, GeneratedArtifact } from './internal/shared/runtime-artifacts'
import { bundleSandboxDefinition } from './bundle'
import {
  defaultCloudflareSandboxBinding,
  defaultCloudflareSandboxClassName,
  defaultCloudflareSandboxMigrationTag,
} from './cloudflare'
import { extractSandboxDefinitionOptions } from './definition-options'
import { getSandboxFeatureProvider } from './module-types'
import type { AgentSandboxConfig, SandboxDefinitionOptions } from './module-types'
import { resolveSandboxProject, type SandboxProject } from './project'
import { createSandboxTypeTemplateContents } from './type-template'
import type { DiscoveredSandboxDefinition } from './discovery'

export const sandboxRuntimeDependencies = [
  '@cloudflare/sandbox',
  '@vercel/sandbox',
]

export const sandboxRuntimeDependencyByProvider = {
  cloudflare: '@cloudflare/sandbox',
  vercel: '@vercel/sandbox',
} as const satisfies Partial<Record<string, string>>

type SandboxProvider = 'cloudflare' | 'vercel'

export function resolveSandboxProviderLoaderTarget(
  provider: SandboxProvider | undefined,
  deps: Record<string, string>,
) {
  if (provider)
    return provider

  const hasCloudflareSandbox = Boolean(deps['@cloudflare/sandbox'])
  const hasVercelSandbox = Boolean(deps['@vercel/sandbox'])

  if (hasCloudflareSandbox === hasVercelSandbox)
    return undefined

  return hasCloudflareSandbox ? 'cloudflare' : 'vercel'
}

export const sandboxProviderLoaderSpecifiers = ['vitehub-sandbox-provider-loader', '@vite-hub/sandbox/runtime/provider-loader', 'virtual:vitehub-sandbox-provider-loader', '#vitehub-sandbox-provider-loader'] as const

function createSandboxProviderLoaderAliases(defaultProviderName: SandboxProvider | undefined): Array<{ key: string, value?: string, artifactKey?: string }> {
  const keys = sandboxProviderLoaderSpecifiers

  if (defaultProviderName)
    return keys.map(key => ({ key, artifactKey: 'sandbox-provider-loader' }))

  const providerLoaderPath = resolveFeatureRuntimePath(
    import.meta.url,
    '@vite-hub/sandbox',
    './runtime/provider-loader',
    'runtime/provider-loader.js',
  )
  return keys.map(key => ({ key, value: providerLoaderPath }))
}

export function createSandboxManifest(aliasPath: string, typeTemplate: string): FeatureManifest {
  return {
    alias: '@vite-hub/sandbox',
    aliasPath,
    imports: [
      { name: 'defineSandbox', from: '@vite-hub/sandbox', meta: { description: 'Define a free-form sandbox resource.' } },
      { name: 'readValidatedPayload', as: 'readValidatedSandboxPayload', from: '@vite-hub/sandbox', meta: { description: 'Validate sandbox payload input before execution.' } },
      { name: 'runSandbox', from: '@vite-hub/sandbox', meta: { description: 'Run a named sandbox definition.' } },
      { name: 'SandboxDefinition', as: 'SandboxDefinition', from: '@vite-hub/sandbox', type: true },
      { name: 'SandboxRunResult', as: 'SandboxRunResult', from: '@vite-hub/sandbox', type: true },
    ],
    typeTemplate: {
      filename: 'runtime/sandbox.d.ts',
      contents: typeTemplate,
    },
  }
}
type SandboxDefinitionMetadata = {
  kind: DiscoveredSandboxDefinition['kind']
  name: string
  options?: SandboxDefinitionOptions
  project?: SandboxProject
}

type SandboxDefinitionCompilerOptions = Partial<DiscoveredDefinitionCompilerOptions> & {
  bundleAlias?: Record<string, string>
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

async function loadSandboxDefinitionMetadata(definitions: DiscoveredSandboxDefinition[], rootDir: string) {
  return await Promise.all(definitions.map(async (definition) => {
    const project = definition.kind === 'package-entry'
      ? await resolveSandboxProject(definition.handler, rootDir, { readSandboxOptions: true })
      : undefined
    return {
      kind: definition.kind,
      name: definition.name,
      options: definition.kind === 'package-entry'
        ? project?.options
        : normalizeSandboxDefinitionOptions(definition.name, await extractSandboxDefinitionOptions(definition.handler)),
      project,
    } satisfies SandboxDefinitionMetadata
  }))
}

function createSandboxRegistryContents(
  definitions: Array<{ name: string, definitionModulePath: string }>,
) {
  return [
    'const registry = {',
    ...definitions.map(definition => `  ${JSON.stringify(definition.name)}: async () => import(${JSON.stringify(definition.definitionModulePath)}),`),
    '}',
    'export default registry',
    '',
  ].join('\n')
}

export function createSandboxProviderLoaderContents(
  provider: SandboxProvider,
) {
  const providerExport = sandboxProviderRuntimeExport(provider)
  const providerLoaderPath = resolveFeatureRuntimePath(
    import.meta.url,
    '@vite-hub/sandbox',
    `./runtime/providers/${provider}`,
    `runtime/providers/${provider}.js`,
  )
  return [
    `import { ${providerExport} as resolveSandboxBox } from ${JSON.stringify(providerLoaderPath)}`,
    '',
    'export async function loadSandboxRuntimeProvider(selectedProvider) {',
    `  if (selectedProvider !== ${JSON.stringify(provider)})`,
    '    throw new Error(`[vitehub] Unsupported sandbox provider for this hosted build: ${selectedProvider}`)',
    '  return {',
    '    resolveSandboxBox,',
    '  }',
    '}',
    '',
  ].join('\n')
}

export function sandboxProviderRuntimeExport(provider: SandboxProvider) {
  return provider === 'cloudflare'
    ? 'resolveCloudflareSandboxBox'
    : 'resolveVercelSandboxBox'
}

export function resolveSandboxFeatureConfig(sandboxConfig: AgentSandboxConfig, hosting?: string): AgentSandboxConfig {
  if (getSandboxFeatureProvider(sandboxConfig)?.provider)
    return { ...sandboxConfig }

  const config = { ...sandboxConfig } as Extract<AgentSandboxConfig, { provider?: undefined }>
  const hostedProvider = getSupportedHostingProvider(hosting, ['cloudflare', 'vercel'])
  if (hostedProvider) {
    return {
      ...config,
      provider: hostedProvider,
    } as AgentSandboxConfig
  }

  const unsupportedHostedProvider = deploymentPresetFromNitro(hosting)
  if (unsupportedHostedProvider) {
    throw new TypeError('[vitehub] Sandbox hosting inference does not support ' + unsupportedHostedProvider + '. An explicit `sandbox.provider` is required.')
  }

  return config
}

export async function createSandboxFeaturePlan(
  sandboxConfig: AgentSandboxConfig,
  definitions: DiscoveredSandboxDefinition[],
  paths: {
    aliasPath: string
  },
  deps: Record<string, string>,
  hosting?: string,
  discoveredDefinitionOptions: SandboxDefinitionCompilerOptions = {},
): Promise<FeatureRuntimePlan> {
  const resolvedConfig = definitions.length > 0
    ? resolveSandboxFeatureConfig(sandboxConfig, hosting)
    : { ...sandboxConfig }
  const sandboxDefinitions = definitions.map(definition => ({
    ...definition,
    definitionArtifactKey: `sandbox-definition:${definition.name}`,
    definitionFilename: `runtime/sandbox-definitions/${toTemplateSafeName(definition.name)}.mjs`,
  }))
  const definitionFileByName = new Map<string, string>()
  for (const definition of sandboxDefinitions) {
    const existing = definitionFileByName.get(definition.definitionFilename)
    if (existing) {
      throw new Error(`[vitehub] Sandbox definitions "${existing}" and "${definition.name}" generate the same artifact path "${definition.definitionFilename}".`)
    }
    definitionFileByName.set(definition.definitionFilename, definition.name)
  }
  const definitionMetadata = await loadSandboxDefinitionMetadata(
    definitions,
    discoveredDefinitionOptions.rootDir || process.cwd(),
  )
  const metadataByName = new Map(definitionMetadata.map(definition => [definition.name, definition] as const))
  const manifest = createSandboxManifest(paths.aliasPath, createSandboxTypeTemplateContents(definitions.map((definition) => {
    return {
      handler: definition.handler,
      kind: definition.kind,
      name: definition.name,
    }
  })))
  const {
    bundleAlias,
    featureImports = manifest.imports,
    ...definitionCompilerOptions
  } = discoveredDefinitionOptions
  const definitionCompiler = await createDiscoveredDefinitionCompiler({
    ...definitionCompilerOptions,
    featureImports,
  })
  const defaultProvider = getSandboxFeatureProvider(resolvedConfig)
  const defaultProviderName = defaultProvider?.provider
  const sandboxArtifacts: GeneratedArtifact[] = sandboxDefinitions.map(definition => ({
    key: definition.definitionArtifactKey,
    filename: definition.definitionFilename,
    async getContents() {
      const source = await definitionCompiler.readSource(definition._meta.sourcePath)
      const metadata = metadataByName.get(definition.name)
      const bundle = await bundleSandboxDefinition(source, definition._meta.sourcePath, {
        alias: bundleAlias,
        execution: metadata?.kind === 'package-entry' ? 'module' : 'definition',
        project: metadata?.project,
      })
      return `export default ${JSON.stringify({
        bundle,
        options: metadata?.options,
      })}\n`
    },
  }))
  const providerLoaderTarget = resolveSandboxProviderLoaderTarget(defaultProviderName, deps)
  const cloudflareOptions = defaultProvider?.provider === 'cloudflare'
    ? {
        binding: typeof defaultProvider.binding === 'string' ? defaultProvider.binding : defaultCloudflareSandboxBinding,
        className: typeof defaultProvider.className === 'string' ? defaultProvider.className : defaultCloudflareSandboxClassName,
        migrationTag: typeof defaultProvider.migrationTag === 'string' ? defaultProvider.migrationTag : defaultCloudflareSandboxMigrationTag,
        name: typeof defaultProvider.name === 'string' ? defaultProvider.name : undefined,
      }
    : undefined

  return {
    manifest,
    aliases: [
      { key: '#vitehub-sandbox-registry', artifactKey: 'sandbox-registry' },
      ...createSandboxProviderLoaderAliases(providerLoaderTarget),
    ],
    artifacts: [
      ...sandboxArtifacts,
      {
        key: 'sandbox-registry',
        filename: 'runtime/sandbox-registry.mjs',
        getContents(emitted) {
          return createSandboxRegistryContents(sandboxDefinitions.map((definition) => {
            const artifact = emitted.get(definition.definitionArtifactKey)
            if (!artifact)
              throw new Error(`[vitehub] Missing generated sandbox definition module for "${definition.name}".`)
            return {
              name: definition.name,
              definitionModulePath: artifact.dst,
            }
          }))
        },
      },
      ...(providerLoaderTarget
        ? [{
            key: 'sandbox-provider-loader',
            filename: 'runtime/sandbox-provider-loader.mjs',
            getContents: () => createSandboxProviderLoaderContents(providerLoaderTarget),
          }]
        : []),
    ],
    cloudflare: cloudflareOptions,
  }
}
