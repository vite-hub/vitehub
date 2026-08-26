import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'vercel',
      blob: true,
      queue: true,
    }),
  ],
})
