export default defineEventHandler((event) => {
  const config = useSafeRuntimeConfig(event)
  return {
    region: config.region,
    timeout: config.timeoutMs,
    ttl: config.cacheTtl,
    host: config.public.posthog.host,
  }
})
