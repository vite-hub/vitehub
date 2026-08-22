import ui from '@vite-hub/ui/vite'
import vue from '@vitejs/plugin-vue'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defaultMaxOwners } from './server/babysitter.queue.ts'
import appConfig from './app/app.config.ts'

export default defineConfig({
  env: {
    server: {
      babysitter: {
        maxOwners: env({ default: defaultMaxOwners, source: env.source('BABYSITTER_MAX_OWNERS') }),
        repositories: env({ default: '', source: env.source('BABYSITTER_REPOS') }),
        repository: env({ default: 'vite-hub/vitehub', source: env.source('BABYSITTER_REPO') }),
      },
      console: {
        url: env({ optional: true, source: env.source('VITEHUB_CONSOLE_URL') }),
        token: env({ optional: true, secret: true, source: env.source('VITEHUB_CONSOLE_TOKEN') }),
      },
    },
  },
  plugins: [
    vue(),
    ...ui({ comark: false, nuxtUI: appConfig }),
    vitehub({
      preset: 'node',
      agent: { providers: { state: { provider: 'sqlite', url: 'file:.vitehub/agent-state.db' } } },
      blob: false,
      database: false,
      kv: { driver: 'fs-lite' },
      schedule: {
        providerOutput: false,
        runtime: { driver: 'process', intervalMs: 1_000 },
      },
      workflow: false,
      workspace: false,
    }),
    nitro({ serverDir: true }),
  ],
})
