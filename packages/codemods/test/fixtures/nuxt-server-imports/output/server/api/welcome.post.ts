import { defineEventHandler, readBody } from "nitro/h3"
import { kv } from "vite-hub/kv"
import { sendQueue } from "vite-hub/queue"

export default defineEventHandler(async (event) => {
  const { email: address } = await readBody<{ email: string }>(event)
  const [error] = await sendQueue("welcome", { address })
  if (error) throw error
  await kv.set(`welcome:${address}`, "queued")
  return { queued: true }
})
