import type { Plugin } from 'vite'
import type { NitroModule } from 'nitro/types'
import { createNoExternalMerger, isServerEnvironment } from '@vitehub/internal/build/vite'

import { createFeatureVitePlugin } from './internal/shared/vite'
import { resolveFeatureRuntimePath } from './internal/shared/feature-runtime-path'
import { sandboxFeatureEngine, type SandboxPublicOptions } from './integration'

export { createViteHubDefinitionAutoImportsPlugin } from './internal/shared/vitehub-auto-imports'

export type SandboxVitePlugin = Plugin & { nitro: NitroModule }

const SANDBOX_PROVIDER_LOADER_ID = 'vitehub-sandbox-provider-loader'

function sandboxProviderLoaderFallback() {
  return resolveFeatureRuntimePath(import.meta.url, '@vitehub/sandbox', './runtime/provider-loader', 'runtime/provider-loader.js')
}

function mergeProviderLoaderAlias(alias: unknown) {
  const replacement = sandboxProviderLoaderFallback()
  if (Array.isArray(alias)) {
    return [
      { find: SANDBOX_PROVIDER_LOADER_ID, replacement },
      ...alias,
    ]
  }

  return {
    ...(alias && typeof alias === 'object' ? alias : {}),
    [SANDBOX_PROVIDER_LOADER_ID]: replacement,
  }
}

function readResolveOptions(config: unknown): { alias?: unknown } {
  if (!config || typeof config !== 'object' || !('resolve' in config))
    return {}

  const resolve = (config as { resolve?: unknown }).resolve
  return resolve && typeof resolve === 'object'
    ? resolve as { alias?: unknown }
    : {}
}

export function hubSandbox(options?: SandboxPublicOptions): SandboxVitePlugin {
  const plugin = createFeatureVitePlugin({
    ...sandboxFeatureEngine,
    readPublicOptions(source) {
      const configOptions = sandboxFeatureEngine.readPublicOptions(source)
      return source.kind === 'vite' && typeof configOptions === 'undefined'
        ? options
        : configOptions
    },
  }) as SandboxVitePlugin
  const configHook = plugin.config
  const configEnvironment = plugin.configEnvironment
  const mergeNoExternal = createNoExternalMerger('@vitehub/sandbox')
  return {
    ...plugin,
    async config(config, env) {
      const result = typeof configHook === 'function'
        ? await configHook.call(this, config, env)
        : undefined
      return {
        ...(result && typeof result === 'object' ? result : {}),
        resolve: {
          ...readResolveOptions(result),
          alias: mergeProviderLoaderAlias(readResolveOptions(result).alias),
        },
      }
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
          alias: mergeProviderLoaderAlias(readResolveOptions(result).alias),
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
