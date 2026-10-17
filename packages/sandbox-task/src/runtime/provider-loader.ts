import type { Sandbox } from '@vite-hub/sandbox'
import type { SandboxTaskDefinitionOptions, SandboxTaskDefinitionProviderOptions } from '../module-types'
import type { SandboxTaskProvider } from '../module-types'
import { sandboxTaskErrorDiagnostics } from "../error-diagnostics.ts"

export interface ResolvedTaskSandbox {
  closeAfterRun?: boolean
  provider: SandboxTaskProvider
  resolveSandbox: (requirements: readonly string[]) => Promise<Sandbox>
  sandboxId?: string
}

export interface SandboxTaskRuntimeProvider {
  resolveTaskSandbox: (
    options: {
      local: SandboxTaskDefinitionOptions
      provider: SandboxTaskDefinitionProviderOptions & { provider: SandboxTaskProvider }
    } | any,
    context?: any,
  ) => Promise<ResolvedTaskSandbox>
}

const dynamicImport = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>

export function unsupportedHostedSandboxTaskProviderError(provider: unknown): Error {
  return sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0076({ message: `[vitehub] Unsupported sandbox provider for this hosted build: ${String(provider)}` })
}

export async function loadSandboxTaskRuntimeProvider(provider: SandboxTaskProvider): Promise<SandboxTaskRuntimeProvider> {
  if (provider === 'cloudflare') {
    const { resolveCloudflareTaskSandbox } = await dynamicImport<typeof import('./providers/cloudflare')>('./providers/cloudflare.js')
    return { resolveTaskSandbox: resolveCloudflareTaskSandbox }
  }

  if (provider === 'vercel') {
    const { resolveVercelTaskSandbox } = await dynamicImport<typeof import('./providers/vercel')>('./providers/vercel.js')
    return { resolveTaskSandbox: resolveVercelTaskSandbox }
  }

  throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0068({ message: `[vitehub] Unsupported sandbox provider: ${provider}` })
}
