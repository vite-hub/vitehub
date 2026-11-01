export default defineEventHandler((event) => {
  const config = useSafeRuntimeConfig(event)
  return {
    apiBase: config.public.apiBase,
    featureEnabled: config.featureEnabled,
    maxRetries: config.maxRetries,
    secretLength: config.apiSecret.length,
  }
})
