import { defineAuth } from '@vite-hub/auth'
import { createAuthHandler } from '@vite-hub/auth/server'

const definition = defineAuth({
  appName: 'Acme',
  route: false,
})

export const handleAuth = createAuthHandler(definition)
