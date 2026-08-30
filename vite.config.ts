import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defaultMaxOwners } from './server/babysitter.queue.ts'

export default defineConfig({
  env: {
    server: {
      babysitter: {
        maxOwners: env({ default: defaultMaxOwners, source: env.source('BABYSITTER_MAX_OWNERS') }),
        repositories: env({ default: '', source: env.source('BABYSITTER_REPOS') }),
        repository: env({ default: 'vite-hub/vitehub', source: env.source('BABYSITTER_REPO') }),
      },
      github: {
        appId: env({ default: '', source: env.source('GITHUB_APP_ID') }),
        installationId: env({ default: '', source: env.source('GITHUB_APP_INSTALLATION_ID') }),
        owner: env({ default: 'vite-hub', source: env.source('GITHUB_APP_OWNER') }),
        privateKey: env({ optional: true, secret: true, source: env.source('GITHUB_APP_PRIVATE_KEY') }),
        token: env({ optional: true, secret: true, source: env.source('GITHUB_TOKEN') }),
      },
      console: {
        url: env({ optional: true, source: env.source('VITEHUB_CONSOLE_URL') }),
        token: env({ optional: true, secret: true, source: env.source('VITEHUB_CONSOLE_TOKEN') }),
      },
    },
  },
  plugins: [
    vitehub({
      preset: 'node',
      agent: { providers: { state: { provider: 'sqlite', url: 'file:.vitehub/agent-state.db' } } },
      blob: false,
      console: { exposure: 'host-managed' },
      database: false,
      kv: { driver: 'fs-lite' },
      schedule: false,
      workflow: false,
      workspace: false,
    }),
    nitro({
      routeRules: { '/': { redirect: '/_vitehub' } },
      serverDir: true,
    }),
  ],
})
