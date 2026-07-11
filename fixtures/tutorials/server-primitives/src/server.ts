import { createServer } from "node:http"

import { kv } from "@vite-hub/kv"
import { H3, readBody } from "h3"
import { toNodeHandler } from "h3/node"

const app = new H3().post("/settings", async (event) => {
  const settings = await readBody<{ theme: string }>(event)

  await kv.set("settings", settings)

  return { settings: await kv.get("settings") }
})

const port = Number(process.env.PORT || 5173)

createServer(toNodeHandler(app)).listen(port, () => {
  console.log(`ViteHub KV tutorial listening on http://localhost:${port}`)
})
