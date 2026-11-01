export default defineEventHandler((event) => {
  const config = useSafeRuntimeConfig(event)
  const { posthog } = config.public
  return {
    region: config.region,
    host: config.public.posthog.host,
    rate: config.public.posthog.sampleRate,
    name: config.public.siteName,
    posthog,
  }
})
