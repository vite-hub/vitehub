import { H3 } from "h3"
import { usePublicEnv } from "#vitehub/env/public"

declare const __VITEHUB_PLAYGROUND_ENV__: string

const app = new H3()

app.get("/", () => ({
  define: __VITEHUB_PLAYGROUND_ENV__,
  env: usePublicEnv(),
  ok: true,
}))

export default app
