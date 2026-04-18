import { resolve } from 'node:path'

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

export default defineNuxtConfig({
  modules: ['@vitehub/sandbox/nuxt'],
  nitro: {
    handlers: [
      {
        route: '/api/sandboxes/release-notes',
        method: 'post',
        handler: resolve(import.meta.dirname, 'server/api/sandboxes/release-notes.post.ts'),
      },
      {
        route: '/api/tests/probe',
        method: 'get',
        handler: resolve(import.meta.dirname, 'server/api/tests/probe.get.ts'),
      },
    ],
  },
  sandbox: resolveSandboxConfig(),
})
