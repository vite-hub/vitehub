import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'vercel',
      blob: true,
      queue: true,
    }),
    nitro(),
  ],
})
