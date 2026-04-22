import { runQueue } from "@vitehub/queue"

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: string }>(event)

  return {
    ok: true,
    result: await runQueue("welcome-email", {
      email: body?.email || "ava@example.com",
    }),
  }
})
