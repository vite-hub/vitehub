import { createServer } from "node:http"

import { H3, readBody } from "h3"
import { toNodeHandler } from "h3/node"
import { kv } from "vite-hub/kv"

const app = new H3().post("/settings", async (event) => {
  const settings = await readBody<{ theme: string }>(event)

  const [writeError] = await kv.set("settings", settings)
  if (writeError) throw writeError

  const [readError, storedSettings] = await kv.get("settings")
  if (readError) throw readError
  return { settings: storedSettings }
})

const port = Number(process.env.PORT || 5173)

createServer(toNodeHandler(app)).listen(port, () => {
  console.log(`ViteHub KV tutorial listening on http://localhost:${port}`)
})
