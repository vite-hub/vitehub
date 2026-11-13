import { useServerEnv } from "vite-hub/env"
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
