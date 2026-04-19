import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { hubSandbox } from '@vitehub/sandbox/vite'

function resolveSandboxConfig() {
  const preset = process.env.NITRO_PRESET || ''
  const explicit = process.env.SANDBOX_PROVIDER
  if (explicit === 'cloudflare' || explicit === 'vercel')
    return { provider: explicit as 'cloudflare' | 'vercel' }
  if (preset.includes('vercel'))
    return { provider: 'vercel' as const }
  return { provider: 'cloudflare' as const }
}

export default defineConfig({
  plugins: [hubSandbox()],
  nitro: {
    handlers: [
      {
        route: '/api/sandboxes/release-notes',
        method: 'post',
        handler: resolve(import.meta.dirname, 'src/run-release-notes.ts'),
      },
      {
        route: '/api/tests/probe',
        method: 'get',
        handler: resolve(import.meta.dirname, 'src/sandbox-probe.ts'),
      },
    ],
  },
  sandbox: resolveSandboxConfig(),
})
