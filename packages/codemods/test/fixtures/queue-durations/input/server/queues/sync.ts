import { defineQueue } from "vite-hub/queue"

export default defineQueue<{ connectionId: string }>(
  async ({ payload }) => {
    console.log(payload.connectionId)
  },
  {
    concurrency: 3,
    onError: () => ({ retry: { delaySeconds: 300 } }),
  },
)
