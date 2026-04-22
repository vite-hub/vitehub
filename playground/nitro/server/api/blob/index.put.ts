import { defineEventHandler, readValidatedBody } from "h3"
import * as v from "valibot"

import { blob } from "@vitehub/blob"

const blobPutBody = v.optional(v.object({
  pathname: v.optional(v.string()),
  value: v.optional(v.string()),
}), {})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, blobPutBody)
  return await blob.put(body?.pathname || "notes/hello.txt", body?.value || "hello world", {
    contentType: "text/plain; charset=utf-8",
  })
})
