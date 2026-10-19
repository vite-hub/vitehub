import { createImportPath } from '@vite-hub/internal/build/paths'
import { deploymentPresetFromNitro } from '@vite-hub/internal/deployment'
import { getSupportedHostingProvider } from '@vite-hub/internal/hosting'
import { createDiscoveredDefinitionCompiler, type DiscoveredDefinitionCompilerOptions } from './internal/shared/discovered-definition'
import { toTemplateSafeName } from './internal/shared/feature-definitions'
import { createFileImportSpecifier } from './internal/shared/file-import-specifier'
import { resolveFeatureRuntimePath } from './internal/shared/feature-runtime-path'
import type {
  FeatureManifest,
  FeatureRuntimePlan,
  GeneratedArtifact,
} from './internal/shared/runtime-artifacts'
import { bundleSandboxTaskDefinition } from './bundle'
import {
  defaultCloudflareSandboxBinding,
  defaultCloudflareSandboxClassName,
  defaultCloudflareSandboxMigrationTag,
} from './cloudflare'
import { extractSandboxTaskDefinitionMetadata } from './definition-options'
import { getSandboxTaskFeatureProvider } from './module-types'
import type { AgentSandboxTaskConfig, SandboxTaskDefinitionOptions } from './module-types'
import { getSandboxTaskProjectSourceFiles, resolveSandboxTaskProject, type SandboxTaskProject } from './project'
import { createSandboxTaskTypeTemplateContents } from './type-template'
import type { DiscoveredSandboxTaskDefinition } from './discovery'
import { sandboxTaskErrorDiagnostics } from "./error-diagnostics.ts"

export const sandboxTaskRuntimeStateSpecifier = '@vite-hub/sandbox-task/runtime/state'
export const sandboxTaskRuntimeSpecifier = '@vite-hub/sandbox-task/_internal/runtime'
export const sandboxTaskRuntimeProviderSpecifiers = {
  cloudflare: `${sandboxTaskRuntimeSpecifier}/providers/cloudflare`,
  vercel: `${sandboxTaskRuntimeSpecifier}/providers/vercel`,
} as const

export const sandboxTaskRuntimeDependencyByProvider = {
  cloudflare: '@cloudflare/sandbox',
  vercel: '@vercel/sandbox',
} as const satisfies Partial<Record<string, string>>

type SandboxTaskProvider = 'cloudflare' | 'vercel'

function resolveSandboxTaskProviderLoaderTarget(
  provider: SandboxTaskProvider | undefined,
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

export const sandboxTaskProviderLoaderSpecifiers = ['vitehub-sandbox-task-provider-loader', '@vite-hub/sandbox-task/runtime/provider-loader', 'virtual:vitehub-sandbox-task-provider-loader', '#vitehub-sandbox-task-provider-loader'] as const

function createSandboxTaskProviderLoaderAliases(defaultProviderName: SandboxTaskProvider | undefined): Array<{ key: string, value?: string, artifactKey?: string }> {
  const keys = sandboxTaskProviderLoaderSpecifiers

  if (defaultProviderName)
    return keys.map(key => ({ key, artifactKey: 'sandbox-task-provider-loader' }))

  const providerLoaderPath = resolveFeatureRuntimePath(
    import.meta.url,
    '@vite-hub/sandbox-task',
    './runtime/provider-loader',
    'runtime/provider-loader.js',
  )
  return keys.map(key => ({ key, value: providerLoaderPath }))
}

function createSandboxTaskManifest(aliasPath: string, typeTemplate: string): FeatureManifest {
  return {
    alias: '@vite-hub/sandbox-task',
    aliasPath,
    imports: [
      { name: 'defineSandboxTask', from: '@vite-hub/sandbox-task', meta: { description: 'Define a free-form sandbox resource.' } },
      { name: 'readValidatedPayload', as: 'readValidatedSandboxTaskPayload', from: '@vite-hub/sandbox-task', meta: { description: 'Validate sandbox payload input before execution.' } },
      { name: 'runSandboxTask', from: '@vite-hub/sandbox-task', meta: { description: 'Run a named sandbox definition.' } },
      { name: 'SandboxTaskDefinition', as: 'SandboxTaskDefinition', from: '@vite-hub/sandbox-task', type: true },
      { name: 'SandboxTaskRunResult', as: 'SandboxTaskRunResult', from: '@vite-hub/sandbox-task', type: true },
    ],
    typeTemplate: {
      filename: 'runtime/sandbox-task.d.ts',
      contents: typeTemplate,
    },
  }
}
type SandboxTaskDefinitionMetadata = {
  kind: DiscoveredSandboxTaskDefinition['kind']
  name: string
  options?: SandboxTaskDefinitionOptions
  project?: SandboxTaskProject
  projectMode?: boolean
}

type SandboxTaskDefinitionCompilerOptions = Partial<DiscoveredDefinitionCompilerOptions> & {
  bundleAlias?: Record<string, string>
}

function normalizeSandboxTaskDefinitionOptions(name: string, options: SandboxTaskDefinitionOptions | undefined) {
  if (!options)
    return undefined

  try {
    return JSON.parse(JSON.stringify(options)) as SandboxTaskDefinitionOptions
  }
  catch (error) {
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0011({ message: `[vitehub] Sandbox Task Definition "${name}" options must be JSON-serializable.`, ...{
      cause: error,
    } })
  }
}

async function loadSandboxTaskDefinitionMetadata(definitions: DiscoveredSandboxTaskDefinition[], rootDir: string) {
  return await Promise.all(definitions.map(async (definition) => {
    const sourceMetadata = definition.kind === 'package-entry'
      ? undefined
      : await extractSandboxTaskDefinitionMetadata(definition.handler)
    const project = sourceMetadata?.project === false
      ? undefined
      : await resolveSandboxTaskProject(definition.handler, rootDir, {
          readSandboxTaskOptions: definition.kind === 'package-entry',
        })
    return {
      kind: definition.kind,
      name: definition.name,
      options: definition.kind === 'package-entry'
        ? project?.options
        : normalizeSandboxTaskDefinitionOptions(definition.name, sourceMetadata?.options),
      project,
      projectMode: sourceMetadata?.project,
    } satisfies SandboxTaskDefinitionMetadata
  }))
}

function createSandboxTaskRegistryContents(
  file: string,
  definitions: Array<{ name: string, definitionModulePath: string, stableDefinitionModulePath: string }>,
  scope: string,
) {
  const scopeSpecifier = createFileImportSpecifier(scope)
  return [
    `import { createGeneratedSandboxTaskRuntimeRegistry } from ${JSON.stringify(sandboxTaskRuntimeStateSpecifier)}`,
    '',
    `const registry = createGeneratedSandboxTaskRuntimeRegistry(${JSON.stringify(scopeSpecifier)}, {`,
    ...definitions.map(definition => [
      `  [${JSON.stringify(definition.name)}]: {`,
      `    load: async () => import(${JSON.stringify(createImportPath(file, definition.definitionModulePath))}),`,
      `    stablePath: ${JSON.stringify(createFileImportSpecifier(definition.stableDefinitionModulePath))},`,
      '  },',
    ].join('\n')),
    '})',
    'export default registry',
    '',
  ].join('\n')
}

function createSandboxTaskProviderLoaderContents(
  provider: SandboxTaskProvider,
) {
  const providerExport = sandboxTaskProviderRuntimeExport(provider)
  const providerLoaderPath = sandboxTaskRuntimeProviderSpecifiers[provider]
  return [
    `import { ${providerExport} as resolveTaskSandbox } from ${JSON.stringify(providerLoaderPath)}`,
    `import { unsupportedHostedSandboxTaskProviderError } from ${JSON.stringify(sandboxTaskRuntimeSpecifier)}`,
    '',
    'export async function loadSandboxTaskRuntimeProvider(selectedProvider) {',
    `  if (selectedProvider !== ${JSON.stringify(provider)})`,
    '    throw unsupportedHostedSandboxTaskProviderError(selectedProvider)',
    '  return {',
    '    resolveTaskSandbox,',
    '  }',
    '}',
    '',
  ].join('\n')
}

export function sandboxTaskProviderRuntimeExport(provider: SandboxTaskProvider) {
  return provider === 'cloudflare'
    ? 'resolveCloudflareTaskSandbox'
    : 'resolveVercelTaskSandbox'
}

export function resolveSandboxTaskFeatureConfig(sandboxTaskConfig: AgentSandboxTaskConfig, hosting?: string): AgentSandboxTaskConfig {
  if (getSandboxTaskFeatureProvider(sandboxTaskConfig)?.provider)
    return { ...sandboxTaskConfig }

  const config = { ...sandboxTaskConfig } as Extract<AgentSandboxTaskConfig, { provider?: undefined }>
  const hostedProvider = getSupportedHostingProvider(hosting, ['cloudflare', 'vercel'])
  if (hostedProvider) {
    return {
      ...config,
      provider: hostedProvider,
    } as AgentSandboxTaskConfig
  }

  const unsupportedHostedProvider = deploymentPresetFromNitro(hosting)
  if (unsupportedHostedProvider) {
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0012({ message: '[vitehub] Sandbox hosting inference does not support ' + unsupportedHostedProvider + '. An explicit `sandbox.provider` is required.' })
  }

  return config
}

export async function createSandboxTaskFeaturePlan(
  sandboxTaskConfig: AgentSandboxTaskConfig,
  definitions: DiscoveredSandboxTaskDefinition[],
  paths: {
    aliasPath: string
  },
  deps: Record<string, string>,
  hosting?: string,
  discoveredDefinitionOptions: SandboxTaskDefinitionCompilerOptions = {},
): Promise<FeatureRuntimePlan> {
  const resolvedConfig = definitions.length > 0
    ? resolveSandboxTaskFeatureConfig(sandboxTaskConfig, hosting)
    : { ...sandboxTaskConfig }
  const sandboxTaskDefinitions = definitions.map(definition => ({
    ...definition,
    definitionArtifactKey: `sandbox-task-definition:${definition.name}`,
    definitionFilename: `runtime/sandbox-task-definitions/${toTemplateSafeName(definition.name)}.mjs`,
  }))
  const definitionFileByName = new Map<string, string>()
  for (const definition of sandboxTaskDefinitions) {
    const existing = definitionFileByName.get(definition.definitionFilename)
    if (existing) {
      throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0013({ message: `[vitehub] Sandbox Task Definitions "${existing}" and "${definition.name}" generate the same artifact path "${definition.definitionFilename}".` })
    }
    definitionFileByName.set(definition.definitionFilename, definition.name)
  }
  const definitionMetadata = await loadSandboxTaskDefinitionMetadata(
    definitions,
    discoveredDefinitionOptions.rootDir || process.cwd(),
  )
  const metadataByName = new Map(definitionMetadata.map(definition => [definition.name, definition] as const))
  const manifest = createSandboxTaskManifest(paths.aliasPath, createSandboxTaskTypeTemplateContents(definitions.map((definition) => {
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
  const defaultProvider = getSandboxTaskFeatureProvider(resolvedConfig)
  const defaultProviderName = defaultProvider?.provider
  const sandboxTaskArtifacts: GeneratedArtifact[] = sandboxTaskDefinitions.map(definition => ({
    key: definition.definitionArtifactKey,
    filename: definition.definitionFilename,
    async getContents() {
      const source = await definitionCompiler.readSource(definition._meta.sourcePath)
      const metadata = metadataByName.get(definition.name)
      const bundle = await bundleSandboxTaskDefinition(source, definition._meta.sourcePath, {
        alias: bundleAlias,
        execution: metadata?.kind === 'package-entry' ? 'module' : 'definition',
        includeProject: metadata?.projectMode,
        project: metadata?.project,
      })
      return `export default ${JSON.stringify({
        bundle,
        options: metadata?.options,
      })}\n`
    },
  }))
  const providerLoaderTarget = resolveSandboxTaskProviderLoaderTarget(defaultProviderName, deps)
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
    watchFiles: [...new Set(definitionMetadata.flatMap(metadata => metadata.project
      ? getSandboxTaskProjectSourceFiles(metadata.project)
      : []))],
    aliases: [
      { key: '#vitehub-sandbox-task-registry', artifactKey: 'sandbox-task-registry' },
      ...createSandboxTaskProviderLoaderAliases(providerLoaderTarget),
    ],
    artifacts: [
      ...sandboxTaskArtifacts,
      {
        key: 'sandbox-task-registry',
        filename: 'runtime/sandbox-task-registry.mjs',
        getContents(emitted, location) {
          return createSandboxTaskRegistryContents(location.dst, sandboxTaskDefinitions.map((definition) => {
            const artifact = emitted.get(definition.definitionArtifactKey)
            if (!artifact)
              throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0014({ message: `[vitehub] Missing generated sandbox definition module for "${definition.name}".` })
            return {
              name: definition.name,
              definitionModulePath: artifact.dst,
              stableDefinitionModulePath: artifact.stableDst,
            }
          }), paths.aliasPath)
        },
      },
      ...(providerLoaderTarget
        ? [{
            key: 'sandbox-task-provider-loader',
            filename: 'runtime/sandbox-task-provider-loader.mjs',
            contents: createSandboxTaskProviderLoaderContents(providerLoaderTarget),
          }]
        : []),
    ],
    cloudflare: cloudflareOptions,
  }
}
