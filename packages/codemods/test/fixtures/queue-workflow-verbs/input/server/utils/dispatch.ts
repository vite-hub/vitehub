import * as queue from "@vite-hub/queue"
import { dynamicQueue, getQueue, runQueue as enqueue } from "@vite-hub/queue"

export async function dispatch(name: string, payload: unknown) {
  const [error] = await dynamicQueue.run(name, payload)
  if (error) throw error
  const client = await dynamicQueue.get(name)
  dynamicQueue.defer(name, payload)
  return client
}

export async function sendDigest(day: number) {
  const digest = await getQueue("digest")
  await digest.sendBatch([{ payload: { day } }])
  return await enqueue("digest", { day })
}

export const helpers = { runQueue: queue.runQueue, getQueue }

export function shadowed(runQueue: (name: string) => void) {
  runQueue("local")
}
