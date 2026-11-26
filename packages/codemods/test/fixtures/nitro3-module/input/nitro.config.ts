import { defineConfig } from 'nitro'
import safeRuntimeConfig from 'nuxt-safe-runtime-config/nitro'

export default defineConfig({
  serverDir: './',
  modules: [safeRuntimeConfig],
  runtimeConfig: { apiSecret: '', greeting: 'hello', port: '3000' },
  safeRuntimeConfig: { $schema: './schema' },
})
