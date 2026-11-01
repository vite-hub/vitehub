import { useServerEnv } from "#vitehub/env/server"
import { usePublicEnv } from "#vitehub/env/public"

export default defineEventHandler((event) => {
  const config = useServerEnv(event)
  return {
    retries: config.maxRetries,
    enabled: config.featureEnabled,
    apiBase: usePublicEnv().apiBase,
    hasSecret: config.apiSecret.length > 0,
  }
})
