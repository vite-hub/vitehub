export default defineEventHandler((event) => {
  const config = useSafeRuntimeConfig(event)
  return {
    retries: config.maxRetries,
    enabled: config.featureEnabled,
    apiBase: config.public.apiBase,
    hasSecret: config.apiSecret.length > 0,
  }
})
