import { defineHandler } from 'nitro'
import { useServerEnv } from 'vite-hub/env'

export default defineHandler(() => {
  const apiSecret = useServerEnv().apiSecret.unseal()
  return { configured: apiSecret.length > 0 }
})
