declare module 'vitehub-sandbox-provider-loader' {
  import type { Box } from '@vite-hub/box'
  import type { SandboxDefinitionOptions, SandboxDefinitionProviderOptions, SandboxProvider } from '../module-types'

  export function loadSandboxRuntimeProvider(selectedProvider: string): Promise<{
    resolveSandboxBox: (
      provider: {
        local: SandboxDefinitionOptions
        provider: SandboxDefinitionProviderOptions & { provider: SandboxProvider }
      },
      context: { event?: unknown },
    ) => Promise<{
      provider: SandboxProvider
      resolveBox: (requirements: readonly string[]) => Promise<Box>
      sandboxId?: string
    }>
  }>
}

declare module 'virtual:vitehub-sandbox-provider-loader' {
  export { loadSandboxRuntimeProvider } from 'vitehub-sandbox-provider-loader'
}

declare module '#vitehub-sandbox-provider-loader' {
  export { loadSandboxRuntimeProvider } from 'vitehub-sandbox-provider-loader'
}

declare module '#vitehub-sandbox-registry' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface SandboxDefinitionModules {}

  const sandboxRegistry: Record<string, unknown>

  export default sandboxRegistry
}
