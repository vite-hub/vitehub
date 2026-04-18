import { defineEventHandler } from "h3"
import { blob } from "@vitehub/blob"

export default defineEventHandler(async () => {
  const pathname = `smoke/hello-${Date.now()}.txt`

  const uploaded = await blob.put(pathname, "hello blob", {
    contentType: "text/plain",
    customMetadata: { source: "smoke" },
  })
  const head = await blob.head(pathname)
  const body = await blob.get(pathname)
  const listed = await blob.list({ prefix: "smoke/" })

  return {
    head,
    listed: listed.blobs.map(item => item.pathname),
    ok: true,
    text: await body?.text(),
    uploaded,
  }
})
