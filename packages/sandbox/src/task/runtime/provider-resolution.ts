import { getActiveCloudflareEnv } from '@vite-hub/internal/runtime/cloudflare-env'
import { createProviderDetector, isCloudflare, isVercel } from '../internal/shared/provider-detection'
import { sandboxTaskError } from '../sandbox-task/errors'

import type {
  SandboxTaskDefinitionOptions,
  SandboxTaskDefinitionDriverOptions,
} from '../module-types'
import type { SandboxTaskDriver } from '../module-types'
import { sandboxTaskErrorDiagnostics } from "../error-diagnostics.ts"

const allowedDefinitionKeys = new Set(['timeout', 'env', 'transfer'])
const transferKeys = new Set(['maxInputBytes', 'maxOutputBytes', 'maxDepth', 'maxSidecars', 'maxSidecarBytes'])
const maxTimeout = 2_147_483_647
const maxTransferLimit = 1_073_741_824

/** The timeout of a Sandbox Task run that sets no `timeout`, on every provider. */
export const DEFAULT_SANDBOX_TASK_TIMEOUT_MS = 300_000
const detectProvider = createProviderDetector<'cloudflare' | 'vercel'>([
  { provider: 'cloudflare', when: isCloudflare },
  { provider: 'vercel', when: isVercel },
])

export function detectSandbox() {
  const env = (typeof process !== 'undefined' ? process.env : {}) as Record<string, string | undefined>
  const type = detectProvider() || 'none'
  if (type === 'cloudflare')
    return { type, details: { runtime: typeof process === 'undefined' ? 'workerd' : 'node' } }
  if (type === 'vercel')
    return { type, details: { env: env.VERCEL_ENV } }
  return { type }
}

function canResolvePackageSync(specifier: string) {
  const runtimeRequire = (globalThis as { require?: { resolve?: (id: string) => string } }).require
  if (typeof runtimeRequire?.resolve === 'function') {
    try {
      runtimeRequire.resolve(specifier)
      return true
    }
    catch {
      return false
    }
  }

  try {
    return typeof (import.meta as ImportMeta & { resolve?: (id: string) => string }).resolve?.(specifier) === 'string'
  }
  catch {
    return false
  }
}

export function isSandboxAvailable(provider?: SandboxTaskDriver): boolean {
  if (provider === 'cloudflare')
    return canResolvePackageSync('@cloudflare/sandbox')
  if (provider === 'vercel')
    return canResolvePackageSync('@vercel/sandbox')
  const detected = detectSandbox()
  return detected.type === 'cloudflare' || detected.type === 'vercel'
    ? isSandboxAvailable(detected.type)
    : false
}

function hashCloudflareSandboxName(name: string) {
  let hash = 2166136261
  for (let index = 0; index < name.length; index++)
    hash = Math.imul(hash ^ name.charCodeAt(index), 16777619)
  return (hash >>> 0).toString(36)
}

export function createCloudflareExecutionSandboxId(name: string, sandboxId?: string) {
  if (sandboxId)
    return sandboxId

  const prefix = 'vitehub-'
  const suffix = `-${hashCloudflareSandboxName(name)}-${crypto.randomUUID()}`
  const slug = encodeURIComponent(name).slice(0, 63 - prefix.length - suffix.length)
  return `${prefix}${slug}${suffix}`
}

export function resolveRuntimeProvider(options?: SandboxTaskDefinitionDriverOptions) {
  if (options?.driver)
    return options.driver

  const envProvider = typeof process !== 'undefined' ? process.env?.SANDBOX_PROVIDER : undefined
  if (envProvider === 'cloudflare' || envProvider === 'vercel')
    return envProvider

  if (getActiveCloudflareEnv())
    return 'cloudflare'

  const detected = detectSandbox()
  if (detected.type === 'cloudflare' || detected.type === 'vercel')
    return detected.type

  throw sandboxTaskError('Sandbox provider could not be inferred. Configure `sandboxTask.driver` as `cloudflare` or `vercel`.', {
    code: 'SANDBOX_TASK_PROVIDER_REQUIRED',
  })
}

export function unsupportedHostedSandboxTaskProviderError(provider: unknown): Error {
  return sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0076({ message: `[vitehub] Unsupported sandbox provider for this hosted build: ${String(provider)}` })
}

export function assertSandboxTaskDefinitionOptions(local: SandboxTaskDefinitionOptions) {
  const invalidKeys = Object.keys(local).filter(key => !allowedDefinitionKeys.has(key))
  if (invalidKeys.length > 0)
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0069({ message: `[vitehub] Sandbox Task Definition options only support timeout, env, and transfer. Unsupported: ${invalidKeys.join(', ')}` })
  if (local.timeout !== undefined
    && (!Number.isInteger(local.timeout) || local.timeout <= 0 || local.timeout > maxTimeout)) {
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0070({ message: `[vitehub] Sandbox Task Definition timeout must be a positive integer no greater than ${maxTimeout}.` })
  }
  assertSandboxTaskTransferOptions(local.transfer)
}

function assertSandboxTaskTransferOptions(transfer: unknown) {
  if (transfer === undefined)
    return
  if (typeof transfer !== 'object' || transfer === null || Array.isArray(transfer))
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_TRANSFER_INVALID({ problem: 'must be an object' })
  const invalidKeys = Object.keys(transfer).filter(key => !transferKeys.has(key))
  if (invalidKeys.length > 0)
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_TRANSFER_INVALID({ problem: `supports only ${[...transferKeys].join(', ')}. Unsupported: ${invalidKeys.join(', ')}` })
  for (const [key, value] of Object.entries(transfer)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > maxTransferLimit))
      throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_TRANSFER_INVALID({ problem: `sets ${key} to ${String(value)}. Each limit must be a whole number from 1 to ${maxTransferLimit}` })
  }
}

export async function resolveTaskSandbox(
  provider: SandboxTaskDriver,
  providerOptions: SandboxTaskDefinitionDriverOptions & { driver: SandboxTaskDriver },
  local: SandboxTaskDefinitionOptions,
) {
  const providerLoader = await import('#vitehub-sandbox-task-provider-loader')
  const runtimeProvider = await providerLoader.loadSandboxTaskRuntimeProvider(provider)
  return await runtimeProvider.resolveTaskSandbox({
    local,
    provider: providerOptions,
  })
}

export function withSandboxTaskProvider(
  provider: SandboxTaskDriver,
  options?: SandboxTaskDefinitionDriverOptions,
) {
  return {
    ...options,
    driver: provider,
  } as SandboxTaskDefinitionDriverOptions & { driver: SandboxTaskDriver }
}

