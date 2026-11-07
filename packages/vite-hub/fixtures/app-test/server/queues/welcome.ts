import { defineQueue } from "vite-hub/queue"

export default defineQueue<{ userId: number }>({
  async handler(job) {
    console.info(`Send the second welcome email to user ${job.payload.userId}.`)
  },
})
