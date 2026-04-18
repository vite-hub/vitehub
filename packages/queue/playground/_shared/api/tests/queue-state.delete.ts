import { defineEventHandler } from "h3"

import { resetQueueState } from "../../utils/queue-state"

export default defineEventHandler(() => {
  resetQueueState()
  return { ok: true }
})
