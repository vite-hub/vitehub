import type { Durability } from "@vite-hub/runtime/durability"

/** What the build passes to `scheduleDurability()`. */
export interface ScheduleDurabilityInput {
  driver: "process"
}

/** The durability of schedule claims. The `process` runtime claims each occurrence in this process only. */
export function scheduleDurability(input: ScheduleDurabilityInput): Durability[] {
  return [{
    primitive: "schedule",
    store: input.driver,
    scope: "process",
    reason: "This process claims each occurrence. Every instance runs every occurrence.",
    fix: "Run the schedules on one instance only. Schedule has no shared lease store for Node yet.",
  }]
}
