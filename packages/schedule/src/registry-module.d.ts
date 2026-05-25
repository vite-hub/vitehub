declare module "#vitehub/schedule/registry" {
  const registry: import("@vitehub/schedule").ScheduleDefinitionRegistry
  export default registry
}

declare module "#vitehub/schedule/targets" {
  export const scheduleTargetNames: import("@vitehub/schedule").ScheduleTargetName[]
  export type ScheduleTargetName = import("@vitehub/schedule").ScheduleTargetName
}
