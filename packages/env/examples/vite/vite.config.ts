import { envSource, envVariable, envVite } from '@vitehub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [envVite({ prefix: 'VITEHUB_' })],
  env: {
    define: {
      __APP_VERSION__: envVariable({
        mode: 'build',
        source: envSource.packageJson('version'),
      }),
    },
    public: {
      appName: envVariable({
        default: 'ViteHub Env',
        mode: 'build',
      }),
    },
  },
})
