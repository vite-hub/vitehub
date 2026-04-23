import type { SandboxConfigValidationIssue, SandboxConfigValidationResult, SandboxProviderOptions } from './types/common'
import { isSupportedVercelSandboxRuntime } from './providers/vercel-runtime'

type VercelProviderOptions = Extract<SandboxProviderOptions, { provider: 'vercel' }>

function validateVercel(provider: VercelProviderOptions): SandboxConfigValidationIssue[] {
  if (!provider.runtime || isSupportedVercelSandboxRuntime(provider.runtime))
    return []

  return [{
    code: 'VERCEL_SANDBOX_RUNTIME_INVALID',
    field: 'runtime',
    severity: 'error',
    message: `[vercel] Unsupported sandbox runtime "${provider.runtime}". Use one of: node22, node24.`,
  }]
}

export function validateSandboxConfig(provider: SandboxProviderOptions): SandboxConfigValidationResult {
  const issues: SandboxConfigValidationIssue[] = []
  if (provider.provider === 'vercel')
    issues.push(...validateVercel(provider))

  return {
    provider: provider.provider,
    ok: issues.every(issue => issue.severity !== 'error'),
    issues,
  }
}
