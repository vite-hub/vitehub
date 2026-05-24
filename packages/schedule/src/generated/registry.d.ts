declare module "#vitehub/schedule/registry" {
  import type { ScheduleDefinitionRegistry } from "../types"

  const registry: ScheduleDefinitionRegistry
  export default registry
}

declare module "#vitehub/schedule/targets" {
  import type { ScheduleTargetName as RuntimeScheduleTargetName } from "../types"

  export const scheduleTargetNames: RuntimeScheduleTargetName[]
  export type ScheduleTargetName = RuntimeScheduleTargetName
}
