import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'deno',
      agent: true,
      console: false,
      schedule: true,
      kv: {
        driver: 'deno-kv',
      },
    }),
  ],
})
