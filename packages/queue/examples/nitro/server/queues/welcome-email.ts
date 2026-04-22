import { defineQueue } from "@vitehub/queue"

export type WelcomeEmailPayload = {
  email: string
  template: "default" | "vip"
}

export default defineQueue<WelcomeEmailPayload>(async (job) => {
  console.log(`Processing ${job.payload.template} welcome email for ${job.payload.email}`)
})
