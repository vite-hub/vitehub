import { defineEventHandler, readBody } from "h3"

import { blob } from "@vitehub/blob"

export default defineEventHandler(async (event) => {
  const body = await readBody<{ pathname?: string, value?: string }>(event)
  return await blob.put(body?.pathname || "notes/example.txt", body?.value || "hello world")
})
