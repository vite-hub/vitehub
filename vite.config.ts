import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { hubAgent } from '@vite-hub/agent/vite'
import { env, hubEnv } from '@vite-hub/env/vite'
import { hubKv } from '@vite-hub/kv/vite'
import { hubSchedule } from '@vite-hub/schedule/vite'
import { defineConfig } from 'vite'

const repositoryPath = join(homedir(), 'vitehub/vitehub')

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: '.output',
    rollupOptions: {
      output: {
        assetFileNames: 'server/_assets/[name]-[hash][extname]',
        chunkFileNames: 'server/_chunks/[name]-[hash].mjs',
        entryFileNames: 'server/index.mjs',
      },
    },
    ssr: 'server/daemon.ts',
  },
  env: {
    server: {
      vitehub: {
        repository: 'vite-hub/vitehub',
        repositoryPath: env({ default: repositoryPath }),
        worktreesPath: env({ default: join(dirname(repositoryPath), 'worktrees') }),
      },
    },
  },
  plugins: [
    hubEnv(),
    hubKv({ driver: 'fs-lite' }),
    hubSchedule({ providerOutput: false }),
    hubAgent(),
  ],
})
