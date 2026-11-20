import { defineServerAuth } from '@nuxtjs/better-auth/config'
import { admin } from 'better-auth/plugins'

export default defineServerAuth(({ runtimeConfig }) => ({
  emailAndPassword: { enabled: true },
  socialProviders: runtimeConfig.githubClientId
    ? { github: { clientId: runtimeConfig.githubClientId, clientSecret: runtimeConfig.githubClientSecret } }
    : undefined,
  plugins: [admin()],
}))
