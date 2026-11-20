import { readBody } from "h3"
import { dynamicQueue, sendQueue, useQueue } from "vite-hub/queue"

export default async function signup(event: Parameters<typeof readBody>[0]) {
  const body = await readBody<{ email: string, wait?: number }>(event)
  const [error] = await sendQueue("welcome-email", { email: body.email }, { delay: "60s", idempotencyKey: body.email })
  if (error) throw error
  await sendQueue("digest", { email: body.email }, { delay: "86400s", retention: 3600 })
  dynamicQueue.send("audit", { email: body.email }, { "delay": "0.5s", delaySecondsNote: true })
  await sendQueue("reminder", { email: body.email }, { delay: body.wait })
  await sendQueue("trial-end", { email: body.email }, { delay: `${Math.max(0, Math.floor(Date.now() / 1000) - 60)}s` })

  const queue = await useQueue("welcome-email")
  await queue.send({ email: body.email }, { delay: "5s" })
  await queue.sendBatch([{ body: { email: body.email }, delay: "10s" }], { delay: undefined, retention: 7200 })
}
