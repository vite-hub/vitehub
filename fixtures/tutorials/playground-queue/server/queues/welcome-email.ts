import { defineQueue } from "vite-hub/queue"

export default defineQueue<{ email: string }>({
  handler: async ({ payload }) => {
    // The job runs in the dev server process. Its log shows in the Console tab.
    console.log(`Sending the welcome email to ${payload.email}`)
  },
})
