import { defineQueue } from "vite-hub/queue"

import { record } from "../oracle"

export default defineQueue<{ id: string }>({
  handler: async ({ payload }) => {
    await new Promise(resolve => setTimeout(resolve, 5))
    await record("job", payload.id)
  },
})
