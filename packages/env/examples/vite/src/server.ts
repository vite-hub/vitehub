import { H3 } from "h3"

import { usePublicEnv, useServerEnv } from "@vite-hub/env"

const app = new H3()

app.get("/api/env", () => {
  const publicEnv = usePublicEnv()
  const serverEnv = useServerEnv()
  const githubToken = serverEnv.github.token.unseal()

  return {
    appName: publicEnv.appName,
    appVersion: __APP_VERSION__,
    githubTokenConfigured: githubToken.length > 0,
  }
})

export default app
