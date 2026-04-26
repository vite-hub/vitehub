import { resolve } from 'node:path'

import { resolveRuntimeEntry as resolveEntry } from '@vitehub/internal/nitro'

import {
  configureCloudflareSandbox,
  defaultCloudflareSandboxBinding,
  defaultCloudflareSandboxClassName,
  defaultCloudflareSandboxMigrationTag,
  installCloudflareSandboxEntrypoint,
  writeCloudflareSandboxDockerfile,
} from '../cloudflare'
import { resolveSandboxProviderLoaderTarget, sandboxRuntimeDependencies, sandboxRuntimeDependencyByProvider } from '../feature'
import { hasInstalledDependency } from '../internal/shared/dependency'
import { tryResolveModule } from '../internal/shared/module-resolve'
import { ensureNitroImports } from '../internal/shared/nitro-imports'
import { applyServerImportsToNitro } from '../internal/shared/server-imports'
import { resolveEffectiveViteHubServerImports } from '../internal/shared/vitehub-server-imports'
import { getSandboxFeatureProvider } from '../module-types'
import { sandboxGeneratedDir } from './runtime-files'

import type { Nitro } from 'nitro/types'
import type { AgentSandboxConfig } from '../module-types'

function resolveRuntimeEntry(srcRelative: string, packageSubpath: string): string {
  return resolveEntry(srcRelative, packageSubpath, import.meta.url)
}

export function createSandboxProviderLoaderAliases(nitro: Nitro, provider: 'cloudflare' | 'vercel' | undefined, deps: Record<string, string>) {
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

export function addSandboxAliases(nitro: Nitro, aliases: Array<{ key: string, value: string }>) {
  nitro.options.alias ||= {}
  nitro.options.alias['@vitehub/sandbox'] = resolveRuntimeEntry('../index', '@vitehub/sandbox')
  nitro.options.alias['@vitehub/sandbox/runtime/state'] = resolveRuntimeEntry('../runtime/state', '@vitehub/sandbox/runtime/state')
  nitro.options.alias['virtual:vitehub-sandbox-registry'] = resolveRuntimeEntry('../runtime/empty-registry', '@vitehub/sandbox/runtime/empty-registry')
  nitro.options.alias['#vitehub-sandbox-registry'] = resolveRuntimeEntry('../runtime/empty-registry', '@vitehub/sandbox/runtime/empty-registry')

  for (const alias of aliases)
    nitro.options.alias[alias.key] = alias.value
}

export function addSandboxImports(nitro: Nitro) {
  ensureNitroImports(nitro)
  applyServerImportsToNitro(
    nitro.options,
    resolveEffectiveViteHubServerImports(nitro.options as Record<string, any>, 'sandbox'),
  )
}

export function extendSandboxNitro(nitro: Nitro, config: AgentSandboxConfig, deps: Record<string, string>, providerLoaderTarget?: 'cloudflare' | 'vercel') {
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
