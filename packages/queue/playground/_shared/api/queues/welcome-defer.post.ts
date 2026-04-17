import { defineEventHandler } from "h3"
import { deferQueue } from "@vitehub/queue"

export default defineEventHandler(async () => {
  deferQueue("welcome-email", {
    email: "deferred@example.com",
  })
  return { ok: true, status: "deferred" }
})
