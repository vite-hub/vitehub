import { useServerEnv } from "vite-hub/env"
import { usePublicEnv } from "#vitehub/env/public"

export default defineEventHandler((event) => {
  const { stripe } = useServerEnv(event), { apiBase } = usePublicEnv()
  const origins = useServerEnv(event).allowedOrigins
  const runtime = useRuntimeConfig(event)
  return { account: stripe.accountId, apiBase, origins, legacy: runtime.maxRetries, untouched: runtime.untouched }
})
