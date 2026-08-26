import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'node',
      kv: {
        driver: 'fs-lite',
        base: '.vitehub/data/kv',
      },
    }),
    nitro() as never,
  ],
})
