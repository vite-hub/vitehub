import { getHostingProvider, getSupportedHostingProvider } from '@vite-hub/internal/hosting'
import { createDiscoveredDefinitionCompiler, type DiscoveredDefinitionCompilerOptions } from './internal/shared/discovered-definition'
import {
  toTemplateSafeName,
  type ScannedDefinition,
} from './internal/shared/feature-definitions'
import { resolveFeatureRuntimePath } from './internal/shared/feature-runtime-path'
import type { FeatureManifest, FeatureRuntimePlan, GeneratedArtifact } from './internal/shared/runtime-artifacts'
import { bundleSandboxDefinition } from './bundle'
import {
  defaultCloudflareSandboxBinding,
  defaultCloudflareSandboxClassName,
  defaultCloudflareSandboxMigrationTag,
} from './cloudflare'
import {
  extractCloudflareDockerfileFragment,
  extractSandboxDefinitionOptions,
  stripCloudflareDockerfileFragment,
} from './definition-options'
import { getSandboxFeatureProvider } from './module-types'
import type { AgentSandboxConfig, SandboxDefinitionOptions } from './module-types'
import { createSandboxTypeTemplateContents } from './type-template'

export const sandboxRuntimeDependencies = [
  '@cloudflare/sandbox',
  '@vercel/sandbox',
]

export const sandboxRuntimeDependencyByProvider = {
  cloudflare: '@cloudflare/sandbox',
  vercel: '@vercel/sandbox',
} as const satisfies Partial<Record<string, string>>

const sandboxClientExportByProvider = {
  cloudflare: 'createCloudflareSandboxClient',
  vercel: 'createVercelSandboxClient',
} as const

export function resolveSandboxProviderLoaderTarget(
  provider: keyof typeof sandboxClientExportByProvider | undefined,
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

function createSandboxProviderLoaderAliases(defaultProviderName: keyof typeof sandboxClientExportByProvider | undefined): Array<{ key: string, value?: string, artifactKey?: string }> {
  const keys = ['vitehub-sandbox-provider-loader', '@vite-hub/sandbox/runtime/provider-loader', 'virtual:vitehub-sandbox-provider-loader', '#vitehub-sandbox-provider-loader']

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
      { name: 'defineSandbox', from: '@vite-hub/sandbox', meta: { description: 'Define a named sandbox resource.' } },
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
  cloudflareDockerfileFragment?: string
  name: string
  options?: SandboxDefinitionOptions
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

async function loadSandboxDefinitionMetadata(definitions: ScannedDefinition[]) {
  return await Promise.all(definitions.map(async (definition) => {
    return {
      cloudflareDockerfileFragment: await extractCloudflareDockerfileFragment(definition.handler),
      name: definition.name,
      options: normalizeSandboxDefinitionOptions(definition.name, await extractSandboxDefinitionOptions(definition.handler)),
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
  provider: keyof typeof sandboxClientExportByProvider,
) {
  const providerLoaderPath = resolveFeatureRuntimePath(
    import.meta.url,
    '@vite-hub/sandbox',
    `./runtime/providers/${provider}`,
    `runtime/providers/${provider}.js`,
  )
  const clientProviderPath = resolveFeatureRuntimePath(
    import.meta.url,
    '@vite-hub/sandbox',
    `./sandbox/providers/${provider}`,
    `sandbox/providers/${provider}.js`,
  )
  const clientExportName = sandboxClientExportByProvider[provider]

  return [
    `import { resolveSandboxProvider } from ${JSON.stringify(providerLoaderPath)}`,
    `import { ${clientExportName} } from ${JSON.stringify(clientProviderPath)}`,
    '',
    'export async function loadSandboxRuntimeProvider(selectedProvider) {',
    `  if (selectedProvider !== ${JSON.stringify(provider)})`,
    '    throw new Error(`[vitehub] Unsupported sandbox provider for this hosted build: ${selectedProvider}`)',
    '  return {',
    '    resolveSandboxProvider,',
    `    createSandboxClient: ${clientExportName},`,
    '  }',
    '}',
    '',
  ].join('\n')
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

  const unsupportedHostedProvider = getHostingProvider(hosting)
  if (unsupportedHostedProvider === 'netlify') {
    throw new TypeError('[vitehub] Sandbox hosting inference does not support Netlify. An explicit `sandbox.provider` is required.')
  }

  return config
}

export async function createSandboxFeaturePlan(
  sandboxConfig: AgentSandboxConfig,
  definitions: ScannedDefinition[],
  paths: {
    aliasPath: string
  },
  deps: Record<string, string>,
  hosting?: string,
  discoveredDefinitionOptions: SandboxDefinitionCompilerOptions = {},
  deferUnresolvedHostingValidation = false,
): Promise<FeatureRuntimePlan> {
  const resolvedConfig = resolveSandboxFeatureConfig(sandboxConfig, hosting)
  const manifest = createSandboxManifest(paths.aliasPath, createSandboxTypeTemplateContents(definitions))
  const {
    bundleAlias,
    featureImports = manifest.imports,
    ...definitionCompilerOptions
  } = discoveredDefinitionOptions
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
  const definitionCompiler = await createDiscoveredDefinitionCompiler({
    ...definitionCompilerOptions,
    featureImports,
  })
  const definitionMetadata = await loadSandboxDefinitionMetadata(definitions)
  const metadataByName = new Map(definitionMetadata.map(definition => [definition.name, definition] as const))
  const defaultProvider = getSandboxFeatureProvider(resolvedConfig)
  const defaultProviderName = defaultProvider?.provider
  const hostingProvider = getHostingProvider(hosting)
  const fragmentDefinitions = definitionMetadata.filter(definition => typeof definition.cloudflareDockerfileFragment === 'string')
  const deferFragmentHostingValidation = deferUnresolvedHostingValidation && typeof hosting === 'undefined'
  if (fragmentDefinitions.length && definitions.length !== 1) {
    throw new Error('[vitehub] A colocated Cloudflare Dockerfile fragment currently requires exactly one discovered Sandbox Definition because Cloudflare provider output owns one app-level Sandbox image. Configure an application-owned Dockerfile until ViteHub can route definitions to distinct images.')
  }
  if (fragmentDefinitions.length
    && !deferFragmentHostingValidation
    && (defaultProviderName !== 'cloudflare' || hostingProvider !== 'cloudflare')) {
    throw new Error('[vitehub] A colocated Cloudflare Dockerfile fragment requires Cloudflare hosting and the Cloudflare Sandbox provider. Other hosts use different image build and routing models.')
  }
  const sandboxArtifacts: GeneratedArtifact[] = sandboxDefinitions.map(definition => ({
    key: definition.definitionArtifactKey,
    filename: definition.definitionFilename,
    async getContents() {
      const source = stripCloudflareDockerfileFragment(
        await definitionCompiler.readSource(definition._meta.sourcePath),
        definition._meta.sourcePath,
      )
      const bundle = await bundleSandboxDefinition(source, definition._meta.sourcePath, {
        alias: bundleAlias,
      })
      const metadata = metadataByName.get(definition.name)
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
        dockerfileFragment: fragmentDefinitions[0]?.cloudflareDockerfileFragment,
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
