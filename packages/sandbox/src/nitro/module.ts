import { readPackageJSON } from 'pkg-types'

import { writeFileIfChanged } from '@vitehub/internal/definition-discovery'

import { createSandboxProviderLoaderContents } from '../feature'
import { hasInstalledDependency } from '../internal/shared/dependency'
import { normalizeSandboxPublicOptions } from '../integration'
import { getSandboxFeatureProvider } from '../module-types'
import { assignSandboxRuntimeConfig, resolveSandboxConfig } from './sandbox-config'
import { writeNitroSandboxRuntimeFiles } from './runtime-files'
import { addSandboxAliases, addSandboxImports, createSandboxProviderLoaderAliases, extendSandboxNitro } from './setup'

import type { NitroModule, NitroRuntimeConfig } from 'nitro/types'
import type { AgentSandboxConfig } from '../module-types'

async function readWorkspaceDeps(rootDir: string) {
  const packageJson = await readPackageJSON(rootDir)
  return {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
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
