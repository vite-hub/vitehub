import type { WelcomeEmailPayload } from "../../queues/welcome-email"

const samplePayload: WelcomeEmailPayload = {
  email: "ava@example.com",
  template: "default",
}

export default defineEventHandler(() => ({
  queue: "welcome-email",
  samplePayload,
}))
