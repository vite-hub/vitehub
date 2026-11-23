import { defineEventHandler, readValidatedBody } from "h3"
import { kv } from "@vite-hub/kv"
import * as v from "valibot"
import { getQueueMarkerKey, getQueueMarkerValue, queueMarkerStages } from "../../../../_shared/queue-test"

const markerBody = v.object({
  error: v.optional(v.string()),
  marker: v.string(),
  stage: v.optional(v.picklist(queueMarkerStages), "done"),
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, markerBody)
  const [error] = await kv.set(getQueueMarkerKey(body.marker, body.stage), getQueueMarkerValue(body.stage, body.error))
  if (error) throw error
  return { ok: true }
})
