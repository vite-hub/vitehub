import { defineQueue } from "@vitehub/queue"

export default defineQueue<{ email: string }>(async (job) => {
  console.log(`Queued welcome email for ${job.payload.email}`)
})
