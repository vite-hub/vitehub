export const scheduleMarkerKey = "schedule-e2e:vite:daily-marker"

export type ScheduleMarker = {
  framework: "vite"
  id: string
  provider: string
  ranAt: string
  schedule: "daily-marker"
}

export function resolveScheduleMarkerProvider() {
  return process.env.VITEHUB_HOSTING || (process.env.VERCEL ? "vercel" : "cloudflare")
}
