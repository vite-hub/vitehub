import { useServerEnv } from "#vitehub/env/server"
import { defineEventHandler } from "h3"

export default defineEventHandler((event) => {
  const config = useServerEnv(event)
  return {
    ok: true,
    playground: config.playground,
  }
})
