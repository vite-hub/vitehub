import { authErrorDiagnostics } from "./error-diagnostics.ts"
import type { AuthEventsConfiguration } from "./events.ts"

export function validateAuthEvents(value: unknown): asserts value is AuthEventsConfiguration | false | undefined {
  if (value === undefined || value === false) return
  if (!value || typeof value !== "object" || !("store" in value) || !value.store || typeof value.store !== "object"
    || !["append", "list", "aggregate"].every(key => typeof Reflect.get(value.store as object, key) === "function")
    || "authorize" in value && value.authorize !== undefined && typeof value.authorize !== "function"
    || "onEvent" in value && value.onEvent !== undefined && typeof value.onEvent !== "function") {
    throw authErrorDiagnostics.AUTH_C0050({ message: "`defineAuth()` events needs a store with append, list, and aggregate methods. events.authorize and events.onEvent must be functions. Set events to false to disable the log." })
  }
}
