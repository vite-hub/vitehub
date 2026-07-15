import { homedir } from 'node:os'
import { join } from 'node:path'
import { hubAgent } from '@vite-hub/agent/vite'
import { env, hubEnv } from '@vite-hub/env/vite'
import { hubKv } from '@vite-hub/kv/vite'
import { hubSchedule } from '@vite-hub/schedule/vite'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  env: {
    server: {
      vitehub: {
        repository: 'vite-hub/vitehub',
        repositoryPath: env({ default: join(homedir(), 'vitehub/vitehub') }),
        worktreesPath: env({ required: true }),
      },
    },
  },
  plugins: [
    hubEnv(),
    hubKv({ driver: 'fs-lite' }),
    hubSchedule({
      providerOutput: false,
      runtime: { driver: 'process', intervalMs: 1_000 },
    }),
    hubAgent({ providers: { state: { provider: 'sqlite', url: 'file:.vitehub/agent-state.db' } } }),
    nitro(),
  ],
})
