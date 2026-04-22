import { H3, readBody } from "h3"

import { blob } from "@vitehub/blob"

const app = new H3()

app.get("/api/blob", async () => await blob.list({ limit: 10 }))
app.put("/api/blob", async (event) => {
  const body = await readBody<{ pathname?: string, value?: string }>(event)
  return await blob.put(body?.pathname || "notes/example.txt", body?.value || "hello world")
})

export default app
