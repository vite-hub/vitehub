import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    env: {
      server: {
        apiSecret: env({ schema: env.schemaFrom('./server/env.schema.ts', 'apiSecret'), secret: true, source: env.source('NITRO_API_SECRET') }),
        greeting: env({ default: 'hello', schema: env.schemaFrom('./server/env.schema.ts', 'greeting'), source: env.source('NITRO_GREETING') }),
        port: env({ default: '3000', schema: env.schemaFrom('./server/env.schema.ts', 'port'), source: env.source('NITRO_PORT') }),
      },
    },
  }), nitro()],
})
