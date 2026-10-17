declare module 'vitehub-sandbox-task-provider-loader' {
  import type { Box } from '@vite-hub/box'
  import type { SandboxTaskDefinitionOptions, SandboxTaskDefinitionProviderOptions, SandboxTaskProvider } from '../module-types'

  export function loadSandboxTaskRuntimeProvider(selectedProvider: string): Promise<{
    resolveSandboxTaskBox: (
      provider: {
        local: SandboxTaskDefinitionOptions
        provider: SandboxTaskDefinitionProviderOptions & { provider: SandboxTaskProvider }
      },
      context: { event?: unknown },
    ) => Promise<{
      provider: SandboxTaskProvider
      resolveBox: (requirements: readonly string[]) => Promise<Box>
      sandboxId?: string
    }>
  }>
}

declare module 'virtual:vitehub-sandbox-task-provider-loader' {
  export { loadSandboxTaskRuntimeProvider } from 'vitehub-sandbox-task-provider-loader'
}

declare module '#vitehub-sandbox-task-provider-loader' {
  export { loadSandboxTaskRuntimeProvider } from 'vitehub-sandbox-task-provider-loader'
}

declare module '#vitehub-sandbox-task-registry' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface SandboxTaskDefinitionModules {}

  const sandboxTaskRegistry: Record<string, unknown>

  export default sandboxTaskRegistry
}
