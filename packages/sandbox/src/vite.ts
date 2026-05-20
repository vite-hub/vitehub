import type { Plugin } from 'vite'
import type { NitroModule } from 'nitro/types'
import { createNoExternalMerger, isServerEnvironment } from '@vitehub/internal/build/vite'

import { createFeatureVitePlugin } from './internal/shared/vite'
import { sandboxFeatureEngine, type SandboxPublicOptions } from './integration'

export { createViteHubDefinitionAutoImportsPlugin } from './internal/shared/vitehub-auto-imports'

export type SandboxVitePlugin = Plugin & { nitro: NitroModule }

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
