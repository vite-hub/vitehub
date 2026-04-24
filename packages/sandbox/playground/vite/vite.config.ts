import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { hubSandbox } from '@vitehub/sandbox/vite'

const buildEntry = 'virtual:vitehub-sandbox-build-entry'

function serverOnlyBuildEntry() {
  return {
    name: 'vitehub-sandbox-build-entry',
    resolveId(id: string) {
      if (id === buildEntry)
        return `\0${buildEntry}`
    },
    load(id: string) {
      if (id === `\0${buildEntry}`)
        return 'export {}'
    },
  }
}

function resolveSandboxConfig() {
  switch (process.env.SANDBOX_PROVIDER) {
    case 'cloudflare':
      return { provider: 'cloudflare' as const }
    case 'vercel':
      return { provider: 'vercel' as const }
    default:
      if ((process.env.NITRO_PRESET || '').includes('cloudflare'))
        return { provider: 'cloudflare' as const }
      if ((process.env.NITRO_PRESET || '').includes('vercel'))
        return { provider: 'vercel' as const }
      return { provider: 'cloudflare' as const }
  }
}

export default defineConfig({
  plugins: [serverOnlyBuildEntry(), hubSandbox()],
  build: {
    rollupOptions: {
      input: buildEntry,
    },
  },
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
