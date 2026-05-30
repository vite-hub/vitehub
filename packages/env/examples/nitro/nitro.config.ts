import { env, envNitro } from '@vite-hub/env/nitro'
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: [envNitro()],
  env: {
    app: {
      name: env({
        default: 'ViteHub Env',
      }),
    },
    auth: {
      token: env({
        secret: true,
      }),
    },
    optionalApiBase: env({
      optional: true,
      source: env.source('PUBLIC_API_BASE'),
    }),
  },
})
