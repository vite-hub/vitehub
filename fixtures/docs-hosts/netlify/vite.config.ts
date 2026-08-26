import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'netlify',
      agent: true,
      blob: true,
      schedule: true,
    }),
    nitro() as never,
  ],
})
