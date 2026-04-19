import { afterEach, describe, expect, it } from 'vitest'

import { assertSandboxDefinitionOptions, resolveRuntimeProvider } from '../src/runtime/runtime-provider'

const originalSandboxProvider = process.env.SANDBOX_PROVIDER

afterEach(() => {
  if (originalSandboxProvider === undefined)
    delete process.env.SANDBOX_PROVIDER
  else
    process.env.SANDBOX_PROVIDER = originalSandboxProvider
})

describe('sandbox runtime provider helpers', () => {
  it('prefers explicit config over environment inference', () => {
    process.env.SANDBOX_PROVIDER = 'cloudflare'

    expect(resolveRuntimeProvider({ provider: 'vercel' })).toBe('vercel')
  })

  it('uses SANDBOX_PROVIDER when present', () => {
    process.env.SANDBOX_PROVIDER = 'vercel'

    expect(resolveRuntimeProvider()).toBe('vercel')
  })

  it('rejects unsupported per-definition options', () => {
    expect(() => assertSandboxDefinitionOptions({
      timeout: 1000,
      runtime: { command: 'node' },
      extra: true,
    } as never)).toThrow(/Unsupported: extra/)
  })
})
