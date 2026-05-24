declare module "#vitehub/schedule/registry" {
  const registry: import("@vitehub/schedule").ScheduleDefinitionRegistry
  export default registry
}

declare module "#vitehub/schedule/targets" {
  import type { ScheduleTargetName as RuntimeScheduleTargetName } from "./types"

  export const scheduleTargetNames: RuntimeScheduleTargetName[]
  export type ScheduleTargetName = RuntimeScheduleTargetName
}
