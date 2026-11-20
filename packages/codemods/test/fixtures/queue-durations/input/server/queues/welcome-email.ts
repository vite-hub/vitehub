import { defineQueue } from "vite-hub/queue"

export default defineQueue<{ email: string }>({
  handler: async ({ payload }) => {
    console.log(payload.email)
  },
  onError: (error, message) => {
    if (message.attempts > 3) {
      message.retry({ delaySeconds: 120 })
      return
    }
    return error instanceof TypeError ? "ack" : { retry: { delaySeconds: 30 } }
  },
})
