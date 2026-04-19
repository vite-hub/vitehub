import { createFeatureNuxtModule } from '../internal/shared/nuxt-feature-module'
import type { AgentSandboxConfig } from '../module-types'
import type { NuxtModule } from '@nuxt/schema'

const sandboxNuxtModule: NuxtModule<AgentSandboxConfig> = createFeatureNuxtModule<AgentSandboxConfig>({ feature: 'sandbox' })

export default sandboxNuxtModule

declare module '@nuxt/schema' {
  interface NuxtConfig { sandbox?: AgentSandboxConfig | false }
  interface NuxtOptions { sandbox?: AgentSandboxConfig | false }
}
