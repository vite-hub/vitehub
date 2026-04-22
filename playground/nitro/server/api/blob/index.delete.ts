import { defineEventHandler, readValidatedBody } from "h3"
import * as v from "valibot"

import { blob } from "@vitehub/blob"

const blobDeleteBody = v.object({
  pathname: v.string(),
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, blobDeleteBody)
  await blob.del(body.pathname)
  return { ok: true }
})
