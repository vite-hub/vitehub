import { defineEventHandler, readValidatedBody } from "h3"
import { kv } from "@vitehub/kv"
import * as v from "valibot"

const markerBody = v.object({
  marker: v.string(),
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, markerBody)
  await kv.set(`workflow-e2e:${body.marker}`, true)
  return { ok: true }
})
