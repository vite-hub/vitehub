import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"

/** What the build passes to `scheduleDurability()`. */
export interface ScheduleDurabilityInput {
  driver: "process"
  /** The process runtime claims occurrences with SQL leases in the Default Database. */
  leases?: boolean
}

/**
 * The durability of schedule claims. With SQL leases in a Postgres Default Database, one instance runs each
 * occurrence. Without them, each process claims each occurrence for itself.
 */
export function scheduleDurability(input: ScheduleDurabilityInput, context: DurabilityContext): Durability[] {
  const database = input.leases ? context.find("database") : undefined
  if (database?.store === "postgres") {
    return [{ primitive: "schedule", store: "postgres", scope: "shared", reason: "Leases in the Default Database. One instance runs each occurrence." }]
  }
  return [{
    primitive: "schedule",
    store: input.driver,
    scope: "process",
    reason: database
      ? `Leases in the ${database.store} Default Database do not lock across processes. Every instance can run every occurrence.`
      : "This process claims each occurrence. Every instance runs every occurrence.",
    fix: input.leases
      ? "Define the Default Database with `dialect: \"postgresql\"`."
      : "Run the schedules on one instance only. Schedule has no shared lease store for Node yet.",
  }]
}
