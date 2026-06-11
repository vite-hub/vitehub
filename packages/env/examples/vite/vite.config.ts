import { env, hubEnv } from '@vite-hub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubEnv({ prefix: 'VITEHUB_' })],
  env: {
    define: {
      __APP_VERSION__: env({
        mode: 'build',
        source: env.packageJson('version'),
      }),
    },
    public: {
      appName: env({
        default: 'ViteHub Env',
        mode: 'build',
      }),
    },
  },
})
