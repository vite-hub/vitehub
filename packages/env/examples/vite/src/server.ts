import { getRouterParam, H3 } from "h3"

import { seal, unseal } from "@vite-hub/env"
import { usePublicEnv } from "#vitehub/env/public"
import { useServerEnv } from "#vitehub/env/server"

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

app.post("/api/tickets", async () => {
  return { ticket: await seal("env-example:ticket", { user: "ada" }, { ttl: 60 }) }
})

app.get("/api/tickets/:ticket", async (event) => {
  const [error, ticket] = await unseal("env-example:ticket", getRouterParam(event, "ticket") ?? "")
  if (error) return Response.json({ code: error.code }, { status: 400 })
  return ticket
})

export default app
