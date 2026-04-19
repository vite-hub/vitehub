import type { Nitro } from 'nitro/types'
import { compileFeatureIntoNitro, type FeatureCompiler } from './internal/shared/feature-compiler'
import { hasInstalledDependency } from './internal/shared/dependency'
import { loadFeatureDefinitions, normalizeDefinitionName } from './internal/shared/feature-definitions'
import { resolveFeatureRuntimePath } from './internal/shared/feature-runtime-path'
import { applyServerImportsToNitro } from './internal/shared/server-imports'
import { resolveEffectiveViteHubServerImports } from './internal/shared/vitehub-server-imports'
import { createSandboxFeaturePlan } from './feature'
import { getSandboxFeatureProvider } from './module-types'
import type { AgentSandboxConfig } from './module-types'

const sandboxFeatureCompiler: FeatureCompiler<AgentSandboxConfig> = {
  feature: 'sandbox',
  async compile(context) {
    applyServerImportsToNitro(
      context.nitro.options,
      resolveEffectiveViteHubServerImports(context.nitro.options as Record<string, any>, 'sandbox'),
    )

    const { definitions } = await loadFeatureDefinitions({
      feature: 'sandbox',
      scanRoots: context.scanRoots,
      subdir: 'sandboxes',
      srcScan: {
        mode: 'recursive',
        filter: relativePath => relativePath.endsWith('.sandbox.ts')
          || relativePath.endsWith('.sandbox.mts')
          || relativePath.endsWith('.sandbox.js')
          || relativePath.endsWith('.sandbox.mjs'),
        normalizeName(relativePath) {
          return normalizeDefinitionName(relativePath.replace(/\.sandbox(\.[cm]?[tj]s)$/i, '$1'))
        },
      },
    })
    return await createSandboxFeaturePlan(context.config, definitions, {
      aliasPath: resolveFeatureRuntimePath(import.meta.url, '@vitehub/sandbox', './index', 'index.mjs'),
      nitroPlugin: resolveFeatureRuntimePath(import.meta.url, '@vitehub/sandbox', '../src/runtime/nitro-plugin', 'runtime/nitro-plugin.js'),
    }, context.deps, context.hosting, {
      rootDir: context.nitro.options.rootDir,
      scanRoots: context.scanRoots,
      nitroImports: context.nitro.options.imports,
    })
  },
}

export async function setupSandboxNitro(nitro: Nitro, sandboxConfig: AgentSandboxConfig | undefined, deps: Record<string, string>) {
  const enabled = await compileFeatureIntoNitro(nitro, sandboxConfig, deps, sandboxFeatureCompiler)
  if (!enabled)
    return

  const defaultProvider = getSandboxFeatureProvider(sandboxConfig)

  if (defaultProvider?.provider === 'vercel' && !hasInstalledDependency(deps, '@vercel/sandbox'))
    nitro.logger.warn('Install `@vercel/sandbox` for Vercel sandbox presets.')
  if (defaultProvider?.provider === 'cloudflare' && !hasInstalledDependency(deps, '@cloudflare/sandbox'))
    nitro.logger.warn('Install `@cloudflare/sandbox` for Cloudflare sandbox presets.')

  nitro.logger.info('`@vitehub/sandbox` enabled')
}
