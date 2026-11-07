import type { Sandbox } from '../../index.ts'
import type { SandboxTaskDefinitionOptions, SandboxTaskDefinitionDriverOptions } from '../module-types'
import type { SandboxTaskDriver } from '../module-types'
import { sandboxTaskErrorDiagnostics } from "../error-diagnostics.ts"

export interface ResolvedTaskSandbox {
  closeAfterRun?: boolean
  provider: SandboxTaskDriver
  resolveSandbox: (requirements: readonly string[]) => Promise<Sandbox>
  sandboxId?: string
}

export interface SandboxTaskRuntimeProvider {
  resolveTaskSandbox: (
    options: {
      local: SandboxTaskDefinitionOptions
      provider: SandboxTaskDefinitionDriverOptions & { driver: SandboxTaskDriver }
    } | any,
  ) => Promise<ResolvedTaskSandbox>
}

const dynamicImport = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>

export async function loadSandboxTaskRuntimeProvider(provider: SandboxTaskDriver): Promise<SandboxTaskRuntimeProvider> {
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
