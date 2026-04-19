import type { NitroModule } from 'nitro/types'
import type { Plugin } from 'vite'
import { createFeatureVitePlugin } from './internal/shared/vite'
export { createViteHubDefinitionAutoImportsPlugin } from './internal/shared/vitehub-auto-imports'
import { sandboxFeatureEngine, type SandboxPublicOptions } from './integration'

export type SandboxVitePlugin = Plugin & { nitro?: NitroModule }

export function hubSandbox(): SandboxVitePlugin {
  return createFeatureVitePlugin(sandboxFeatureEngine) as SandboxVitePlugin
}

declare module 'vite' {
  interface UserConfig {
    sandbox?: SandboxPublicOptions
  }
}
