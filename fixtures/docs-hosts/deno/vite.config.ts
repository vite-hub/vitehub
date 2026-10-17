import { hubSchedule } from '@vite-hub/schedule/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'deno',
      agent: true,
      console: false,
      workflow: false,
      kv: {
        driver: 'deno-kv',
      },
    }),
    hubSchedule({ providerOutput: 'standalone' }),
  ],
})
