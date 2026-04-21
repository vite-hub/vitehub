import { kv } from "@vitehub/kv"
import { defineQueue } from "@vitehub/queue"

export default defineQueue<{ email: string, marker?: string }>(async (job) => {
  if (typeof job.payload.marker === "string") {
    await kv.set(`queue-e2e:${job.payload.marker}`, true)
  }
})
