import { H3 } from "h3"
import buildConfig from "virtual:@vitehub/env/build"

declare const __VITEHUB_PLAYGROUND_ENV__: string

const app = new H3()

app.get("/", () => ({
  define: __VITEHUB_PLAYGROUND_ENV__,
  env: buildConfig.public,
  ok: true,
}))

export default app
