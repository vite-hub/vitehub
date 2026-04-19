declare module '#vitehub-sandbox-provider-loader' {
  import type { SandboxDefinitionOptions, SandboxDefinitionProviderOptions } from '../module-types'
  import type { SandboxClient, SandboxProvider, SandboxProviderOptions } from '../sandbox/types'

  export function loadSandboxRuntimeProvider(selectedProvider: string): Promise<{
    resolveSandboxProvider: (
      provider: {
        local: SandboxDefinitionOptions
        provider: SandboxDefinitionProviderOptions & { provider: SandboxProvider }
      },
      context: { event?: unknown },
    ) => Promise<SandboxProviderOptions>
    createSandboxClient: (provider: SandboxProviderOptions) => Promise<SandboxClient>
  }>
}

declare module '#vitehub-sandbox-registry' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface SandboxDefinitionModules {}

  const sandboxRegistry: Record<string, unknown>

  export default sandboxRegistry
}

declare module 'virtual:vitehub-sandbox-provider-loader' {
  import type { SandboxDefinitionOptions, SandboxDefinitionProviderOptions } from '../module-types'
  import type { SandboxClient, SandboxProvider, SandboxProviderOptions } from '../sandbox/types'

  export function loadSandboxRuntimeProvider(selectedProvider: string): Promise<{
    resolveSandboxProvider: (
      provider: {
        local: SandboxDefinitionOptions
        provider: SandboxDefinitionProviderOptions & { provider: SandboxProvider }
      },
      context: { event?: unknown },
    ) => Promise<SandboxProviderOptions>
    createSandboxClient: (provider: SandboxProviderOptions) => Promise<SandboxClient>
  }>
}

declare module 'virtual:vitehub-sandbox-registry' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface SandboxDefinitionModules {}

  const sandboxRegistry: Record<string, unknown>

  export default sandboxRegistry
}
