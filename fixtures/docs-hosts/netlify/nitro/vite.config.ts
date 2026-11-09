import { hubSchedule } from '@vite-hub/schedule/vite'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'netlify',
      agent: { invocations: false },
      blob: true,
    }),
    nitro(),
    hubSchedule({ providerOutput: 'standalone' }),
  ],
})
