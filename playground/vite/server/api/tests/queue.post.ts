import { defineEventHandler, readValidatedBody } from "h3"
import { kv } from "@vite-hub/kv"
import * as v from "valibot"

const markerBody = v.object({
  marker: v.string(),
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, markerBody)
  const [error] = await kv.set(`queue-e2e:${body.marker}`, true)
  if (error) throw error
  return { ok: true }
})
