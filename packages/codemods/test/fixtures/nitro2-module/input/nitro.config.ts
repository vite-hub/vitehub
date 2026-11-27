import safeRuntimeConfig from 'nuxt-safe-runtime-config/nitro'
import * as v from 'valibot'
export default defineNitroConfig({
  modules: [safeRuntimeConfig],
  runtimeConfig: { databaseUrl: '' },
  safeRuntimeConfig: { $schema: v.object({ databaseUrl: v.pipe(v.string(), v.url()) }) },
})
