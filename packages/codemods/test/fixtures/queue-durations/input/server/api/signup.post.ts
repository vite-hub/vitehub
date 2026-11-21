import { readBody } from "h3"
import { dynamicQueue, sendQueue, useQueue } from "vite-hub/queue"

export default async function signup(event: Parameters<typeof readBody>[0]) {
  const body = await readBody<{ email: string, wait?: number }>(event)
  const [error] = await sendQueue("welcome-email", { email: body.email }, { delaySeconds: 60, idempotencyKey: body.email })
  if (error) throw error
  await sendQueue("digest", { email: body.email }, { delaySeconds: 24 * 60 * 60, retentionSeconds: 3600 })
  dynamicQueue.send("audit", { email: body.email }, { "delaySeconds": 0.5, delaySecondsNote: true })
  await sendQueue("reminder", { email: body.email }, { delaySeconds: body.wait })
  await sendQueue("trial-end", { email: body.email }, { delaySeconds: Math.max(0, Math.floor(Date.now() / 1000) - 60) })

  const queue = await useQueue("welcome-email")
  await queue.send({ email: body.email }, { delaySeconds: 5 })
  await queue.sendBatch([{ body: { email: body.email }, delaySeconds: 10 }], { delaySeconds: undefined, retentionSeconds: 7200 })
}
