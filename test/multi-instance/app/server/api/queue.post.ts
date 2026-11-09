import { defineHandler, readBody } from "h3"
import { runQueue } from "vite-hub/queue"

export default defineHandler(async (event) => {
  const { ids } = await readBody<{ ids: string[] }>(event) ?? { ids: [] }
  const errors: string[] = []
  for (const id of ids) {
    const [error] = await runQueue("jobs", { id })
    if (error) errors.push(error.message)
  }
  return { errors, queued: ids.length - errors.length }
})
