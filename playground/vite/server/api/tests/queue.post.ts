import { defineEventHandler, readValidatedBody } from "h3"
import { kv } from "@vite-hub/kv"
import * as v from "valibot"
import { getQueueMarkerKey, queueMarkerStages } from "../../../../_shared/queue-test"

const markerBody = v.object({
  error: v.optional(v.string()),
  marker: v.string(),
  stage: v.optional(v.picklist(queueMarkerStages), "done"),
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, markerBody)
  const [error] = await kv.set(getQueueMarkerKey(body.marker, body.stage), body.stage === "failed" ? body.error || "unknown error" : true)
  if (error) throw error
  return { ok: true }
})
