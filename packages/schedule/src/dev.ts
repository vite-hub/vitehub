/** Console route for manual Static Schedule runs on a deployment. */
export const scheduleConsoleRunRoute = "_vitehub/schedules/run"

/** Vite Development Server route that `vitehub schedule` commands call. */
export const scheduleDevRoute = "/__vitehub/schedule/dev"
/** Nitro route that the dev endpoint forwards Schedule operations to. The route exists only in `vite dev`. */
export const scheduleDevRuntimeRoute = "/_vitehub/schedule/dev"
export const scheduleDevHeader = "x-vitehub-schedule-dev"
export const scheduleDevHeaderValue = "1"
export const scheduleDevTokenNamespace = "schedule"
export const scheduleDevTokenServerHeader = "x-vitehub-schedule-dev-server"

/**
 * Schedule operations that the dev endpoint accepts. `runs` and `attempts` read recorded Schedule Runs. `run-static`
 * starts a Static Schedule Definition that sets `manual: true`.
 */
export const scheduleDevOperations = ["runs", "attempts", "run-static"] as const

export type ScheduleDevOperation = typeof scheduleDevOperations[number]

export interface ScheduleDevRequestBody {
  id?: string
  limit?: number
  operation: ScheduleDevOperation
}

export function isScheduleDevOperation(value: unknown): value is ScheduleDevOperation {
  return scheduleDevOperations.some(operation => operation === value)
}
