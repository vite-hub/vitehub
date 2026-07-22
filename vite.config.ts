import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  env: {
    server: {
      babysitter: {
        maxOwners: env({ default: '6', source: env.source('BABYSITTER_MAX_OWNERS') }),
        repositories: env({ default: '', source: env.source('BABYSITTER_REPOS') }),
        repository: env({ default: 'vite-hub/vitehub', source: env.source('BABYSITTER_REPO') }),
      },
    },
  },
  plugins: [
    vitehub({
      preset: 'node',
      agent: { providers: { state: { provider: 'sqlite', url: 'file:.vitehub/agent-state.db' } } },
      blob: false,
      database: false,
      devtools: false,
      kv: { driver: 'fs-lite' },
      schedule: {
        providerOutput: false,
        runtime: { driver: 'process', intervalMs: 1_000 },
      },
      workflow: false,
      workspace: false,
    }),
    nitro(),
  ],
})
