import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildFeatureNitroContext,
  createFeatureEngine,
} from '../src/feature-bridge/feature-engine.ts'
import { detectHosting } from '../src/feature-bridge/hosting.ts'

afterEach(() => {
  delete process.env.NITRO_PRESET
  delete process.env.VITEHUB_HOSTING
})

describe('feature bridge hosting', () => {
  it('prefers configured Nitro preset over NITRO_PRESET env', () => {
    process.env.NITRO_PRESET = 'cloudflare'

    expect(detectHosting({
      options: {
        preset: 'vercel',
      },
    })).toBe('vercel')
  })

  it('detects Nitro CLI preset arguments before falling back to NITRO_PRESET', () => {
    process.env.NITRO_PRESET = 'cloudflare'
    const originalArgv = process.argv
    process.argv = ['node', 'nitro', 'build', '--preset=vercel']

    try {
      expect(detectHosting({
        options: {},
      })).toBe('vercel')
    }
    finally {
      process.argv = originalArgv
    }
  })

  it('falls back to explicit ViteHub hosting env', () => {
    process.env.VITEHUB_HOSTING = 'vercel'

    expect(detectHosting({
      options: {},
    })).toBe('vercel')
  })
})

describe('feature bridge state', () => {
  it('preserves explicit false config in Nitro runtime config', async () => {
    const setupNitro = vi.fn()
    const engine = createFeatureEngine<false | { enabled: boolean }, { enabled: boolean }, false | { enabled: boolean }>({
      name: '@vitehub/test-feature',
      feature: 'testFeature',
      configKey: 'testFeature',
      normalizeOptions(options) {
        if (options === false) return
        return options
      },
      readPublicOptions(source) {
        return source.kind === 'nitro'
          ? (source.nitro.options as { testFeature?: false | { enabled: boolean } }).testFeature
          : undefined
      },
      setupNitro,
    })
    const nitro = {
      options: {
        rootDir: process.cwd(),
        runtimeConfig: {},
        testFeature: false,
      },
    }

    const context = await buildFeatureNitroContext(engine, nitro)

    expect(nitro.options.runtimeConfig).toEqual({
      testFeature: false,
    })
    expect(context?.config).toBe(false)
  })
})
