import { defineHandler } from 'nitro'
import { useRuntimeConfig } from 'nitro/runtime-config'

export default defineHandler(() => {
  const { apiSecret } = useRuntimeConfig()
  return { configured: apiSecret.length > 0 }
})
