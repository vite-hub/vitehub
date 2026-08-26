import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'vercel',
      database: {
        connection: {
          url: env({ source: env.source('TURSO_DATABASE_URL') }),
          authToken: env({ secret: true, source: env.source('TURSO_AUTH_TOKEN') }),
        },
      },
    }),
    nitro() as never,
  ],
})
