import { defineQueue } from "@vite-hub/queue"
import { reportQueueMarker } from "../../../_shared/queue-test"

export default defineQueue<{ callbackUrl?: string, email: string, marker?: string }>({
  handler: async ({ payload }) => {
    await reportQueueMarker(payload.marker, payload.callbackUrl)
  },
})
