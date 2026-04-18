import { defineQueue } from "@vitehub/queue"

import { pushQueueJob } from "../utils/queue-state"

export default defineQueue(async (job) => {
  const payload = job.payload as { marker?: unknown }
  if (typeof payload.marker === "string") {
    console.log(`[vitehub-queue-e2e] ${payload.marker}`)
  }

  pushQueueJob({
    attempts: job.attempts,
    id: job.id,
    payload: job.payload,
  })
})
