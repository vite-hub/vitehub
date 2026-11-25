import { useServerEnv } from "vite-hub/env"

export default defineEventHandler((event) => {
  const config = useServerEnv(event)
  return { tags: config.tags, level: config.logLevel }
})
