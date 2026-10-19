import { describe, expect, it } from 'vitest'
import vm from 'node:vm'

import { collectCloudflareErrorMessages } from '../src/internal/shared/cloudflare-retry.ts'

describe('collectCloudflareErrorMessages', () => {
  it('includes messages from foreign-realm errors and their causes', () => {
    const error = vm.runInNewContext(`
      const outer = new Error('sandbox startup failed')
      outer.cause = new Error('container is starting')
      outer
    `) as unknown

    expect(collectCloudflareErrorMessages(error)).toContain('sandbox startup failed')
    expect(collectCloudflareErrorMessages(error)).toContain('container is starting')
  })

  it('includes local error messages, direct causes, and extra context', () => {
    const error = new Error('startup failed', { cause: new Error('container is starting') })
    expect(collectCloudflareErrorMessages(error, 'context')).toBe('startup failed\ncontainer is starting\ncontext')
  })

  it('does not accept a spoofed Error brand', () => {
    const error = {
      [Symbol.toStringTag]: 'Error',
      message: 'container is starting',
      toString: () => 'ordinary failure',
    }
    expect(collectCloudflareErrorMessages(error)).toBe('ordinary failure')
  })

  it.each(['message', 'cause'])('falls back when an Error %s getter throws', (property) => {
    const error = new Error('startup failed')
    Object.defineProperty(error, property, { get() { throw new Error('access denied') } })
    error.toString = () => 'ordinary failure'
    expect(collectCloudflareErrorMessages(error, 'context')).toBe('ordinary failure\ncontext')
  })

  it('guards a direct cause message getter', () => {
    const cause = new Error('container is starting')
    Object.defineProperty(cause, 'message', { get() { throw new Error('access denied') } })
    const error = new Error('startup failed', { cause })
    expect(collectCloudflareErrorMessages(error)).toBe('Error: startup failed')
  })

  it('guards spoofed message getters', () => {
    const error = {
      [Symbol.toStringTag]: 'Error',
      get message() { throw new Error('access denied') },
      toString: () => 'ordinary failure',
    }
    expect(collectCloudflareErrorMessages(error)).toBe('ordinary failure')
  })

  it('preserves context when stringification also throws', () => {
    const error = { toString() { throw new Error('access denied') } }
    expect(collectCloudflareErrorMessages(error, 'context')).toBe('context')
  })

  it('does not inspect non-Error causes or recurse through causes', () => {
    const spoofedCause = { [Symbol.toStringTag]: 'Error', message: 'container is starting' }
    expect(collectCloudflareErrorMessages(new Error('failed', { cause: spoofedCause }))).toBe('failed')
    const cause = new Error('direct cause', { cause: new Error('nested cause') })
    expect(collectCloudflareErrorMessages(new Error('failed', { cause }))).toBe('failed\ndirect cause')
  })

})
