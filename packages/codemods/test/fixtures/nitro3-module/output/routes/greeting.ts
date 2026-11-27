import { defineHandler } from 'nitro'
import { useServerEnv } from 'vite-hub/env'

export default defineHandler(() => {
  const config = useServerEnv()
  return { greeting: config.greeting, port: config.port }
})
