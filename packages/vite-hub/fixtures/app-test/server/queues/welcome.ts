import { defineQueue } from "vite-hub/queue"

export default defineQueue<{ userId: number }>({
  handler: async ({ payload }) => {
    console.info(`Send the second welcome email to user ${payload.userId}.`)
  },
})
