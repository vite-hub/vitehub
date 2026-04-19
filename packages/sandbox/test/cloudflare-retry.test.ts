import { describe, expect, it } from 'vitest'

import { isRetriableCloudflareError } from '../src/internal/shared/cloudflare-retry'
import { SandboxError } from '../src/sandbox/errors'

describe('isRetriableCloudflareError', () => {
  it('retries timeout-style Cloudflare sandbox errors', () => {
    const error = new SandboxError('request timed out', {
      code: 'TIMEOUT',
      provider: 'cloudflare',
    })

    expect(isRetriableCloudflareError(error)).toBe(true)
  })

  it('retries known Cloudflare startup failures by message', () => {
    expect(isRetriableCloudflareError(new Error('Container is starting, retry in a moment'))).toBe(true)
  })

  it('does not treat non-Cloudflare provider errors as retriable', () => {
    const error = new SandboxError('request timed out', {
      code: 'TIMEOUT',
      provider: 'vercel',
    })

    expect(isRetriableCloudflareError(error)).toBe(false)
  })

  it('rejects unrelated generic failures', () => {
    expect(isRetriableCloudflareError(new Error('permission denied'))).toBe(false)
  })
})
