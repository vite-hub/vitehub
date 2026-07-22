import { getViteHubErrorShape, ViteHubError } from '@vite-hub/runtime'

import type { ViteHubErrorDetail, ViteHubErrorDetails } from '@vite-hub/runtime'

export interface SandboxErrorMetadata {
  code?: `SANDBOX_${string}`
  provider?: string
  method?: string
  httpStatus?: number
  details?: Record<string, unknown>
  cause?: unknown
}

function sanitizeSandboxDetail(value: unknown, depth = 0, seen = new WeakSet<object>()): ViteHubErrorDetail | undefined {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return value.slice(0, 16_384)
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (!value || typeof value !== 'object' || depth >= 8 || seen.has(value)) return undefined

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.slice(0, 128).flatMap(item => {
        const sanitized = sanitizeSandboxDetail(item, depth + 1, seen)
        return sanitized === undefined ? [] : [sanitized]
      })
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined
    const result: Record<string, ViteHubErrorDetail | undefined> = {}
    for (const [key, item] of Object.entries(value).slice(0, 128)) {
      if (!key || key.length > 128) continue
      result[key] = sanitizeSandboxDetail(item, depth + 1, seen)
    }
    return result
  }
  catch {
    return undefined
  }
  finally {
    seen.delete(value)
  }
}

function sanitizeSandboxDetails(details: Record<string, unknown> | undefined) {
  const sanitized = sanitizeSandboxDetail(details)
  return sanitized && !Array.isArray(sanitized) && typeof sanitized === 'object' ? sanitized as ViteHubErrorDetails : undefined
}

export function sandboxError(message: string, metadata: SandboxErrorMetadata = {}): ViteHubError<`SANDBOX_${string}`> {
  const { cause, code = 'SANDBOX_RUNTIME_ERROR', details, httpStatus, method, provider } = metadata
  return new ViteHubError(code, message.slice(0, 16_384) || 'Sandbox execution failed.', {
    cause,
    details: sanitizeSandboxDetails({
      ...(provider === undefined ? {} : { provider }),
      ...(method === undefined ? {} : { method }),
      ...(httpStatus === undefined ? {} : { httpStatus }),
      ...sanitizeSandboxDetails(details),
    }),
  })
}

export function isSandboxError(value: unknown): value is ViteHubError<`SANDBOX_${string}`> {
  return getViteHubErrorShape(value)?.code.startsWith('SANDBOX_') === true
}
