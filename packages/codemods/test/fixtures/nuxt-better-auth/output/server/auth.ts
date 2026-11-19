import { defineAuth } from 'vite-hub/auth'
import { admin } from 'better-auth/plugins'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { authDatabase } from 'vite-hub/auth/database'

export default defineAuth(() => {
  const runtimeConfig = useRuntimeConfig()
  return ({
    database: authDatabase(),
    access: { routes: ['/api/notes/**'] },
    emailAndPassword: { enabled: true },
    socialProviders: runtimeConfig.githubClientId
      ? { github: { clientId: runtimeConfig.githubClientId, clientSecret: runtimeConfig.githubClientSecret } }
      : undefined,
    plugins: [admin()],
  })
})
