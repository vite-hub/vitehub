import { defineQueue } from "@vitehub/queue"

export default defineQueue<{ email: string }>(async (job) => {
  console.log(`Processing welcome email for ${job.payload.email}`)
})
