import type { Box } from '@vite-hub/box'
import type { SandboxTaskDefinitionOptions, SandboxTaskDefinitionProviderOptions } from '../module-types'
import type { SandboxTaskProvider } from '../module-types'
import { sandboxTaskErrorDiagnostics } from "../error-diagnostics.ts"

export interface ResolvedSandboxTaskBox {
  closeAfterRun?: boolean
  provider: SandboxTaskProvider
  resolveBox: (requirements: readonly string[]) => Promise<Box>
  sandboxId?: string
}

export interface SandboxTaskRuntimeProvider {
  resolveSandboxTaskBox: (
    options: {
      local: SandboxTaskDefinitionOptions
      provider: SandboxTaskDefinitionProviderOptions & { provider: SandboxTaskProvider }
    } | any,
    context?: any,
  ) => Promise<ResolvedSandboxTaskBox>
}

const dynamicImport = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>

export function unsupportedHostedSandboxTaskProviderError(provider: unknown): Error {
  return sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0076({ message: `[vitehub] Unsupported sandbox provider for this hosted build: ${String(provider)}` })
}

export async function loadSandboxTaskRuntimeProvider(provider: SandboxTaskProvider): Promise<SandboxTaskRuntimeProvider> {
  if (provider === 'cloudflare') {
    const { resolveCloudflareSandboxTaskBox } = await dynamicImport<typeof import('./providers/cloudflare')>('./providers/cloudflare.js')
    return { resolveSandboxTaskBox: resolveCloudflareSandboxTaskBox }
  }

  if (provider === 'vercel') {
    const { resolveVercelSandboxTaskBox } = await dynamicImport<typeof import('./providers/vercel')>('./providers/vercel.js')
    return { resolveSandboxTaskBox: resolveVercelSandboxTaskBox }
  }

  throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0068({ message: `[vitehub] Unsupported sandbox provider: ${provider}` })
}
