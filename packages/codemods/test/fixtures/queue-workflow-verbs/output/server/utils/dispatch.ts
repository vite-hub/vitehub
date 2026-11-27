import * as queue from "@vite-hub/queue"
import { dynamicQueue, useQueue, sendQueue as enqueue } from "@vite-hub/queue"

export async function dispatch(name: string, payload: unknown) {
  const [error] = await dynamicQueue.send(name, payload)
  if (error) throw error
  const client = await dynamicQueue.use(name)
  dynamicQueue.defer(name, payload)
  return client
}

export async function sendDigest(day: number) {
  const digest = await useQueue("digest")
  await digest.sendBatch([{ payload: { day } }])
  return await enqueue("digest", { day })
}

export const helpers = { runQueue: queue.sendQueue, getQueue: useQueue }

export function shadowed(runQueue: (name: string) => void) {
  runQueue("local")
}
