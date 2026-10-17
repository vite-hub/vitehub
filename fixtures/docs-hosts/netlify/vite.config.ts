import { hubSchedule } from '@vite-hub/schedule/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'netlify',
      agent: true,
      blob: true,
    }),
    hubSchedule({ providerOutput: 'standalone' }),
  ],
})
