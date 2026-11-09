import { defineQueue } from "vite-hub/queue"

import { record } from "../oracle"

export default defineQueue<{ id: string }>(async ({ payload }) => {
  // A short pause gives the other instances a chance to take jobs from a shared queue.
  await new Promise(resolve => setTimeout(resolve, 5))
  await record("job", payload.id)
})
