import { runQueue } from "vite-hub/queue"

export async function retry(send: typeof runQueue) {
  return await send("retry", {})
}

export function withLocal(runQueue: (name: string) => void) {
  runQueue("local")
}
