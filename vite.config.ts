import ui from '@vite-hub/ui/vite'
import vue from '@vitejs/plugin-vue'
import { chmod, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defaultMaxOwners } from './server/babysitter.queue.ts'
import appConfig from './app/app.config.ts'

const drainHelper = new URL('./scripts/babysitter-drain', import.meta.url)

export default defineConfig({
  optimizeDeps: { exclude: ['vue-router'] },
  resolve: { dedupe: ['vue', 'vue-router'] },
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
    vue(),
    ...ui({ comark: false, nuxtUI: appConfig }),
    vitehub({
      preset: 'node',
      agent: { providers: { state: { provider: 'sqlite', url: 'file:.vitehub/agent-state.db' } } },
      blob: false,
      database: false,
      kv: { driver: 'fs-lite' },
      schedule: false,
      workflow: false,
      workspace: false,
    }),
    nitro({
      serverDir: true,
      hooks: {
        async compiled(nitro) {
          const output = resolve(nitro.options.output.serverDir, 'babysitter-drain')
          await copyFile(drainHelper, output)
          await chmod(output, 0o755)
        },
      },
    }),
  ],
})
