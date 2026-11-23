import { defineQueue } from "@vite-hub/queue"
import { reportQueueDelivery } from "../../../_shared/queue-test"

export default defineQueue<{ callbackUrl?: string, email: string, marker?: string }>({
  handler: async ({ payload }) => {
    await reportQueueDelivery(payload)
  },
})
