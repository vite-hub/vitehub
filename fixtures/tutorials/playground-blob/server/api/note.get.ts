import { defineEventHandler, getQuery } from "h3"
import { blob } from "vite-hub/blob"

export default defineEventHandler(async (event) => {
  const { text = "Hello from Blob" } = getQuery<{ text?: string }>(event)

  const [writeError] = await blob.put("notes/hello.txt", text, { contentType: "text/plain" })
  if (writeError) throw writeError

  const [readError, file] = await blob.get("notes/hello.txt")
  if (readError) throw readError
  return { path: "notes/hello.txt", type: file?.type, text: await file?.text() }
})
