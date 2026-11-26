import { defineHandler } from 'nitro'
import { useRuntimeConfig } from 'nitro/runtime-config'

export default defineHandler(() => {
  const config = useRuntimeConfig()
  return { greeting: config.greeting, port: config.port }
})
