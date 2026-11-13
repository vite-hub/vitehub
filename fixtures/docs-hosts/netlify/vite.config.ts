import { hubSchedule } from '@vite-hub/schedule/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'netlify',
      agent: { invocations: false },
      blob: true,
    }),
    hubSchedule({ providerOutput: 'standalone' }),
  ],
})
