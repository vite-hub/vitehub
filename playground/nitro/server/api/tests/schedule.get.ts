import { defineEventHandler } from "h3"
import { kv } from "@vitehub/kv"

import { scheduleMarkerKey } from "../../schedules/daily-marker"

export default defineEventHandler(async () => {
  const marker = await kv.get(scheduleMarkerKey)
  return {
    ok: true,
    marker,
    seen: Boolean(marker),
  }
})
