import { kv } from "@vitehub/kv"

export default defineQueue<{ email: string, marker?: string }>(async (job) => {
  if (typeof job.payload.marker === "string") {
    await kv.set(`queue-e2e:${job.payload.marker}`, true)
  }
})
