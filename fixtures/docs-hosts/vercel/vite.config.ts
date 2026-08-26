import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'vercel',
      blob: true,
      queue: true,
    }),
    nitro() as never,
  ],
})
