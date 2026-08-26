import { hubSchedule } from '@vite-hub/schedule/vite'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'deno',
      agent: true,
      kv: {
        driver: 'deno-kv',
      },
    }),
    hubSchedule({ providerOutput: 'standalone' }),
    nitro() as never,
  ],
})
