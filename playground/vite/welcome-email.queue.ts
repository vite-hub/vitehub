import { defineQueue } from "@vitehub/queue"

import { appendQueueState } from "./queue-state.ts"

export default defineQueue<{ email: string, marker?: string }>(async (job) => {
  if (typeof job.payload.marker === "string") {
    console.log(`[vitehub-queue-e2e] ${job.payload.marker}`)
  }

  await appendQueueState({
    attempts: job.attempts,
    id: job.id,
    payload: job.payload,
  })
})
