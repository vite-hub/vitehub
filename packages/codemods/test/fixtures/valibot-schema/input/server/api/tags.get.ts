export default defineEventHandler((event) => {
  const config = useSafeRuntimeConfig(event)
  return { tags: config.tags, level: config.logLevel }
})
