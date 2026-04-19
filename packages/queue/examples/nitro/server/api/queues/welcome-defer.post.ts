import { deferQueue } from "@vitehub/queue"

export default defineEventHandler(() => {
  deferQueue("welcome-email", {
    email: "ava@example.com",
  })

  return { ok: true }
})
