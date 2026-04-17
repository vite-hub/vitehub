import { runQueue } from "@vitehub/queue"

export default defineEventHandler(async () => {
  return await runQueue("welcome-email", {
    id: "welcome-ava",
    payload: { email: "ava@example.com" },
    delaySeconds: 5,
  })
})
