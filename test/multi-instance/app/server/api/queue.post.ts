import { defineHandler, readBody } from "h3"
import { sendQueue } from "vite-hub/queue"

import type { Duration } from "vite-hub/runtime"

export default defineHandler(async (event) => {
  const { delay, ids } = await readBody<{ delay?: Duration, ids: string[] }>(event) ?? { ids: [] }
  const errors: string[] = []
  for (const id of ids) {
    const [error] = await sendQueue("jobs", { id }, { delay })
    if (error) errors.push(error.message)
  }
  return { errors, queued: ids.length - errors.length }
})
