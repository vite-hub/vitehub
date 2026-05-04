import { envNitro, envSource, envVariable } from '@vitehub/env/nitro'
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: [envNitro()],
  env: {
    app: {
      name: envVariable({
        default: 'ViteHub Env',
      }),
    },
    auth: {
      token: envVariable({
        secret: true,
      }),
    },
    optionalApiBase: envVariable({
      optional: true,
      source: envSource.env('PUBLIC_API_BASE'),
    }),
  },
})
