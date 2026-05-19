import type { Plugin } from 'vite'
import type { NitroModule } from 'nitro/types'

import { createFeatureVitePlugin } from './internal/shared/vite'
import { sandboxFeatureEngine, type SandboxPublicOptions } from './integration'

export { createViteHubDefinitionAutoImportsPlugin } from './internal/shared/vitehub-auto-imports'

export type SandboxVitePlugin = Plugin & { nitro: NitroModule }

export function hubSandbox(options?: SandboxPublicOptions): SandboxVitePlugin {
  return createFeatureVitePlugin({
    ...sandboxFeatureEngine,
    readPublicOptions(source) {
      const configOptions = sandboxFeatureEngine.readPublicOptions(source)
      return source.kind === 'vite' && typeof configOptions === 'undefined'
        ? options
        : configOptions
    },
  }) as SandboxVitePlugin
}

declare module 'vite' {
  interface UserConfig {
    sandbox?: SandboxPublicOptions
  }
}
