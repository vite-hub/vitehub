import { H3, readBody } from "h3"

import { blob } from "@vite-hub/blob"

const app = new H3()

app.get("/api/blob", async () => {
  const [error, result] = await blob.list({ limit: 10 })
  if (error) throw error
  return result
})
app.put("/api/blob", async (event) => {
  const body = await readBody<{ pathname?: string, value?: string }>(event)
  const [error, object] = await blob.put(body?.pathname || "notes/example.txt", body?.value || "hello world")
  if (error) throw error
  return object
})

export default app
