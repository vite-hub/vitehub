import { createDiscoveredDefinitionCompiler, type DiscoveredDefinitionCompilerOptions } from './internal/shared/discovered-definition'
import { hasInstalledDependency } from './internal/shared/dependency'
import {
  toTemplateSafeName,
  type ScannedDefinition,
} from './internal/shared/feature-definitions'
import { resolveFeatureRuntimePath } from './internal/shared/feature-runtime-path'
import { tryResolveModule } from './internal/shared/module-resolve'
import { getHostingProvider, getSupportedHostingProvider } from './internal/shared/hosting'
import type { FeatureManifest, FeatureRuntimePlan, GeneratedArtifact } from './internal/shared/runtime-artifacts'
import { bundleSandboxDefinition } from './bundle'
import {
  configureCloudflareSandbox,
  defaultCloudflareSandboxBinding,
  defaultCloudflareSandboxClassName,
  defaultCloudflareSandboxMigrationTag,
  installCloudflareSandboxEntrypoint,
  writeCloudflareSandboxDockerfile,
} from './cloudflare'
import { extractSandboxDefinitionOptions } from './definition-options'
import { getSandboxFeatureProvider } from './module-types'
import type { AgentSandboxConfig, SandboxDefinitionOptions } from './module-types'
import { createSandboxTypeTemplateContents } from './type-template'

export const sandboxRuntimeDependencies = [
  '@cloudflare/sandbox',
  '@vercel/sandbox',
]

const sandboxRuntimeDependencyByProvider = {
  cloudflare: '@cloudflare/sandbox',
  vercel: '@vercel/sandbox',
} as const satisfies Partial<Record<string, string>>

const sandboxClientExportByProvider = {
  cloudflare: 'createCloudflareSandboxClient',
  vercel: 'createVercelSandboxClient',
} as const

export function createSandboxManifest(aliasPath: string, nitroPlugin: string, typeTemplate: string): FeatureManifest {
  return {
    alias: '@vitehub/sandbox',
    aliasPath,
    nitroPlugin,
    imports: [
      { name: 'defineSandbox', from: '@vitehub/sandbox', meta: { description: 'Define a named sandbox resource.' } },
      { name: 'readValidatedPayload', as: 'readValidatedSandboxPayload', from: '@vitehub/sandbox', meta: { description: 'Validate sandbox payload input before execution.' } },
      { name: 'runSandbox', from: '@vitehub/sandbox', meta: { description: 'Run a named sandbox definition.' } },
      { name: 'SandboxDefinition', as: 'SandboxDefinition', from: '@vitehub/sandbox', type: true },
      { name: 'SandboxRunResult', as: 'SandboxRunResult', from: '@vitehub/sandbox', type: true },
    ],
    typeTemplate: {
      filename: 'runtime/sandbox.d.ts',
      contents: typeTemplate,
    },
  }
}

type SandboxDefinitionMetadata = {
  name: string
  options?: SandboxDefinitionOptions
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

function createSandboxProviderLoaderContents(
  provider: keyof typeof sandboxClientExportByProvider,
) {
  const providerLoaderPath = resolveFeatureRuntimePath(
    import.meta.url,
    '@vitehub/sandbox',
    `./runtime/providers/${provider}`,
    `runtime/providers/${provider}.js`,
  )
  const clientProviderPath = resolveFeatureRuntimePath(
    import.meta.url,
    '@vitehub/sandbox',
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
    '    throw new Error(`[vitehub] Unsupported sandbox provider for this Nitro build: ${selectedProvider}`)',
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
    throw new TypeError('[vitehub] Sandbox hosting inference does not support Netlify. Set `sandbox.provider` explicitly.')
  }

  return config
}

export async function createSandboxFeaturePlan(
  sandboxConfig: AgentSandboxConfig,
  definitions: ScannedDefinition[],
  paths: {
    aliasPath: string
    nitroPlugin: string
  },
  deps: Record<string, string>,
  hosting?: string,
  discoveredDefinitionOptions: Partial<DiscoveredDefinitionCompilerOptions> = {},
): Promise<FeatureRuntimePlan> {
  const resolvedConfig = resolveSandboxFeatureConfig(sandboxConfig, hosting)
  const manifest = createSandboxManifest(paths.aliasPath, paths.nitroPlugin, createSandboxTypeTemplateContents(definitions))
  const definitionCompiler = await createDiscoveredDefinitionCompiler(discoveredDefinitionOptions)
  const definitionMetadata = await loadSandboxDefinitionMetadata(definitions)
  const metadataByName = new Map(definitionMetadata.map(definition => [definition.name, definition] as const))
  const sandboxDefinitions = definitions.map(definition => ({
    ...definition,
    definitionArtifactKey: `sandbox-definition:${definition.name}`,
    definitionFilename: `runtime/sandbox-definitions/${toTemplateSafeName(definition.name)}.mjs`,
  }))
  const sandboxArtifacts: GeneratedArtifact[] = sandboxDefinitions.map(definition => ({
    key: definition.definitionArtifactKey,
    filename: definition.definitionFilename,
    async getContents() {
      const source = await definitionCompiler.readSource(definition._meta.sourcePath)
      const bundle = await bundleSandboxDefinition(source, definition._meta.sourcePath)
      const metadata = metadataByName.get(definition.name)
      return `export default ${JSON.stringify({
        bundle,
        options: metadata?.options,
      })}\n`
    },
  }))
  const defaultProvider = getSandboxFeatureProvider(resolvedConfig)
  const defaultProviderName = defaultProvider?.provider
  const cloudflareOptions = defaultProvider?.provider === 'cloudflare'
    ? {
        binding: typeof defaultProvider.binding === 'string' ? defaultProvider.binding : defaultCloudflareSandboxBinding,
        className: typeof defaultProvider.className === 'string' ? defaultProvider.className : defaultCloudflareSandboxClassName,
        migrationTag: typeof defaultProvider.migrationTag === 'string' ? defaultProvider.migrationTag : defaultCloudflareSandboxMigrationTag,
      }
    : undefined

  return {
    manifest,
    aliases: [
      { key: 'virtual:vitehub-sandbox-registry', artifactKey: 'sandbox-registry' },
      { key: '#vitehub-sandbox-registry', artifactKey: 'sandbox-registry' },
      ...(defaultProviderName
        ? [
            { key: 'virtual:vitehub-sandbox-provider-loader', artifactKey: 'sandbox-provider-loader' },
            { key: '#vitehub-sandbox-provider-loader', artifactKey: 'sandbox-provider-loader' },
          ]
        : []),
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
      ...(defaultProviderName
        ? [{
            key: 'sandbox-provider-loader',
            filename: 'runtime/sandbox-provider-loader.mjs',
            getContents: () => createSandboxProviderLoaderContents(defaultProviderName),
          }]
        : []),
    ],
    extendNitro(target) {
      const nitroTarget = target as typeof target & {
        externals?: {
          inline?: string[]
          traceInclude?: string[]
        }
      }
      if (cloudflareOptions) {
        configureCloudflareSandbox(nitroTarget, cloudflareOptions)
        installCloudflareSandboxEntrypoint(nitroTarget, cloudflareOptions)
      }

      nitroTarget.externals = nitroTarget.externals || {}
      nitroTarget.externals.inline = nitroTarget.externals.inline || []
      nitroTarget.externals.traceInclude = nitroTarget.externals.traceInclude || []

      const runtimeDependencies = defaultProviderName
        ? [sandboxRuntimeDependencyByProvider[defaultProviderName]].filter(Boolean)
        : sandboxRuntimeDependencies

      for (const dependency of runtimeDependencies) {
        if (!hasInstalledDependency(deps, dependency))
          continue

        if (dependency !== '@vercel/sandbox' && !nitroTarget.externals.inline.includes(dependency))
          nitroTarget.externals.inline.push(dependency)

        const resolved = tryResolveModule(dependency)
        if (resolved.ok && !nitroTarget.externals.traceInclude.includes(resolved.path))
          nitroTarget.externals.traceInclude.push(resolved.path)
      }
    },
    async onCompiled(nitro) {
      if (cloudflareOptions)
        await writeCloudflareSandboxDockerfile(nitro.options.output.serverDir)
    },
  }
}
