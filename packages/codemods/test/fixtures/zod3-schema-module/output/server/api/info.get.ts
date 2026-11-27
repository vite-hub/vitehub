import { useServerEnv } from "vite-hub/env"
import { usePublicEnv } from "#vitehub/env/public"

export default defineEventHandler((event) => {
  const config = useServerEnv(event)
  return {
    region: config.region,
    timeout: config.timeoutMs,
    ttl: config.cacheTtl,
    host: usePublicEnv().posthogHost,
  }
})
