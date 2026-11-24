import { defineQueue } from "vite-hub/queue"

export default defineQueue({
  async handler(job: { address: string }) {
    const [error] = await email.send({ to: job.address, template: "welcome" })
    if (error) throw error
    await sendQueue("audit", { address: job.address })
  },
})
