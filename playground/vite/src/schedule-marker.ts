export const scheduleMarkerKey = "schedule-e2e:daily-marker"

export type ScheduleMarker = {
  id: string
  provider: string
  ranAt: string
  schedule: "daily-marker"
}

export function resolveScheduleMarkerProvider() {
  return process.env.VITEHUB_HOSTING || (process.env.VERCEL ? "vercel" : "cloudflare")
}
