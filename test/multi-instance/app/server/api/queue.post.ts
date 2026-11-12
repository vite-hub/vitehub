import { defineHandler, readBody } from "h3"
import { sendQueue } from "vite-hub/queue"

export default defineHandler(async (event) => {
  const { delaySeconds, ids } = await readBody<{ delaySeconds?: number, ids: string[] }>(event) ?? { ids: [] }
  const errors: string[] = []
  for (const id of ids) {
    const [error] = await sendQueue("jobs", { id }, { delaySeconds })
    if (error) errors.push(error.message)
  }
  return { errors, queued: ids.length - errors.length }
})
