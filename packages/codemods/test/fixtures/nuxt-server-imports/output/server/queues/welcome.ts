import { defineQueue, sendQueue } from "vite-hub/queue"
import { email } from "vite-hub/email"

export default defineQueue({
  async handler(job: { address: string }) {
    const [error] = await email.send({ to: job.address, template: "welcome" })
    if (error) throw error
    await sendQueue("audit", { address: job.address })
  },
})
