export default defineEventHandler((event) => {
  const { stripe, public: { apiBase } } = useSafeRuntimeConfig(event)
  const origins = useSafeRuntimeConfig(event).allowedOrigins
  const runtime = useRuntimeConfig(event)
  return { account: stripe.accountId, apiBase, origins, legacy: runtime.maxRetries, untouched: runtime.untouched }
})
