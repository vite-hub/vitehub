import { defineHandler, readBody } from "h3"
import { blob } from "vite-hub/blob"

export default defineHandler(async (event) => {
  const { path, value } = await readBody<{ path: string, value: string }>(event) ?? { path: "", value: "" }
  const [error] = await blob.put(path, value, { contentType: "text/plain" })
  if (error) throw error
  return { ok: true }
})
