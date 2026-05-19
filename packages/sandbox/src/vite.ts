import type { NitroModule } from 'nitro/types'
import type { Plugin } from 'vite'
import { createNoExternalMerger, isServerEnvironment } from '@vitehub/internal/build/vite'
import { createFeatureVitePlugin } from './internal/shared/vite'
export { createViteHubDefinitionAutoImportsPlugin } from './internal/shared/vitehub-auto-imports'
import { sandboxFeatureEngine, type SandboxPublicOptions } from './integration'

export type SandboxVitePlugin = Plugin & { nitro?: NitroModule }

export function hubSandbox(): SandboxVitePlugin {
  const plugin = createFeatureVitePlugin(sandboxFeatureEngine) as SandboxVitePlugin
  const configEnvironment = plugin.configEnvironment
  const mergeNoExternal = createNoExternalMerger('@vitehub/sandbox')
  return {
    ...plugin,
    configEnvironment(name, config) {
      const result = typeof configEnvironment === 'function'
        ? configEnvironment.call(this, name, config, undefined as never)
        : undefined
      if (!isServerEnvironment(name, config)) {
        return result
      }
      return {
        ...(result || {}),
        resolve: {
          ...(typeof result === 'object' && result && 'resolve' in result ? result.resolve : {}),
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
