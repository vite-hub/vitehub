import { useSafeRuntimeConfig } from '#vitehub/env/server'

export default defineEventHandler((event) => {
  const config = useSafeRuntimeConfig(event)

  return {
    appName: config.app.name,
    hasAuthToken: Boolean(config.auth.token),
    optionalApiBase: config.optionalApiBase,
  }
})
