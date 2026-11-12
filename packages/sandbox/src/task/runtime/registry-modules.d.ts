declare module 'vitehub-sandbox-task-provider-loader' {
  import type { Sandbox } from '@vite-hub/sandbox'
  import type { SandboxTaskDefinitionOptions, SandboxTaskDefinitionDriverOptions, SandboxTaskDriver } from '../module-types'

  export function loadSandboxTaskRuntimeProvider(selectedProvider: string): Promise<{
    resolveTaskSandbox: (
      provider: {
        local: SandboxTaskDefinitionOptions
        provider: SandboxTaskDefinitionDriverOptions & { driver: SandboxTaskDriver }
      },
    ) => Promise<{
      provider: SandboxTaskDriver
      resolveSandbox: (requirements: readonly string[]) => Promise<Sandbox>
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
