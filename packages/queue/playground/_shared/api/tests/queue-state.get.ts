import { defineEventHandler } from "h3"

import { getQueueState } from "../../utils/queue-state"

export default defineEventHandler(() => ({
  jobs: getQueueState(),
  ok: true,
}))
