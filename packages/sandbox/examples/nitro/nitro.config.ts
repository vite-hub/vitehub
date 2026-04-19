import { resolve } from 'node:path'
import { defineNitroConfig } from 'nitro/config'
import type { AgentSandboxConfig } from '@vitehub/sandbox'

declare module 'nitro/types' {
  interface NitroConfig {
    sandbox?: false | AgentSandboxConfig
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

export default defineNitroConfig({
  serverDir: 'server',
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
  modules: ['@vitehub/sandbox/nitro'],
  sandbox: resolveSandboxConfig(),
})
