import { defineQueue } from "@vitehub/queue"

import { pushQueueJob } from "../utils/queue-state"

export default defineQueue(async (job) => {
  pushQueueJob({
    attempts: job.attempts,
    id: job.id,
    payload: job.payload,
  })
})
