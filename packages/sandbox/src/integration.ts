import { createFeatureEngine, normalizeFeaturePublicOptions, readFeaturePublicOptions } from './internal/shared/feature-engine'
import { resolveSandboxFeatureConfig } from './feature'
import type { AgentSandboxConfig } from './module-types'
import { getSandboxFeatureProvider } from './module-types'
import { setupSandboxNitro } from './setup-nitro'

export type SandboxPublicOptions = AgentSandboxConfig | false

export function normalizeSandboxPublicOptions(options: SandboxPublicOptions | undefined): AgentSandboxConfig | undefined {
  return normalizeFeaturePublicOptions('sandbox', options)
}

function assignSandboxRuntimeConfig(runtimeConfig: Record<string, unknown>, config: AgentSandboxConfig) {
  const provider = getSandboxFeatureProvider(config)
  if (provider?.provider === 'vercel') {
    const runtimeSandboxConfig = {
      ...config,
      token: provider.token ?? '',
      teamId: provider.teamId ?? '',
      projectId: provider.projectId ?? '',
    } as AgentSandboxConfig
    runtimeConfig.sandbox = runtimeSandboxConfig
    return
  }

  runtimeConfig.sandbox = config
}

export const sandboxFeatureEngine = createFeatureEngine<SandboxPublicOptions, AgentSandboxConfig>({
  name: '@vitehub/sandbox',
  feature: 'sandbox',
  configKey: 'sandbox',
  defaultOptions: () => ({}),
  loadDeps: true,
  normalizeOptions: normalizeSandboxPublicOptions,
  resolveConfig: resolveSandboxFeatureConfig,
  assignRuntimeConfig: assignSandboxRuntimeConfig,
  readPublicOptions: source => readFeaturePublicOptions(source, 'sandbox'),
  async setupNitro(nitro, context) {
    await setupSandboxNitro(nitro, context.config, context.deps)
  },
})
