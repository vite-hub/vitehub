export const scheduleMarkerKey = "schedule-e2e:daily-marker"

export type ScheduleMarker = {
  id: string
  ranAt: string
  schedule: "daily-marker"
}
