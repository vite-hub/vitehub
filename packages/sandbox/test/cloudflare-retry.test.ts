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
})
