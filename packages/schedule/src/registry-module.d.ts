declare module "#vitehub/schedule/registry" {
  const registry: import("@vite-hub/schedule").ScheduleDefinitionRegistry
  export default registry
}

declare module "#vitehub/schedule/targets" {
  export const scheduleTargetNames: import("@vite-hub/schedule").ScheduleTargetName[]
  export type ScheduleTargetName = import("@vite-hub/schedule").ScheduleTargetName
}
