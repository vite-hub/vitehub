import { defineEventHandler, getQuery } from "h3"
import { kv } from "@vite-hub/kv"
import { getQueueMarkerKey } from "../../../../_shared/queue-test"

export default defineEventHandler(async (event) => {
  const marker = getQuery(event).marker
  if (typeof marker !== "string" || marker.length === 0) {
    return { error: null, ok: true, received: false, seen: false, writeError: null }
  }

  const [seenError, seen] = await kv.has(getQueueMarkerKey(marker, "done"))
  if (seenError) throw seenError
  const [receivedError, received] = await kv.has(getQueueMarkerKey(marker, "received"))
  if (receivedError) throw receivedError
  const [failureError, failure] = await kv.get(getQueueMarkerKey(marker, "failed"))
  if (failureError) throw failureError
  const [writeFailureError, writeFailure] = await kv.get(getQueueMarkerKey(marker, "marker-write"))
  if (writeFailureError) throw writeFailureError
  return {
    error: typeof failure === "string" ? failure : null,
    ok: true,
    received,
    seen,
    writeError: typeof writeFailure === "string" ? writeFailure : null,
  }
})
