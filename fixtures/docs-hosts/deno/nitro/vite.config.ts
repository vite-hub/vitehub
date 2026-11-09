import { hubSchedule } from '@vite-hub/schedule/vite'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'deno',
      agent: true,
      console: false,
      workflow: false,
      kv: {
        driver: 'deno-kv',
      },
    }),
    nitro(),
    hubSchedule({ providerOutput: 'standalone' }),
  ],
})
