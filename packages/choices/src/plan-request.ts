/** What `resolve()` knows about a plan state that the state does not hold: the group keys, in state order, and the request `context`. */
export interface PlanRequest {
  context: unknown
  keys: readonly string[]
}

// A registered symbol, so a second copy of this package in one app reads the same key.
const planRequestKey = Symbol.for("vitehub.choices.planRequest")

/** Puts the request on the state as a hidden property. JSON, and so the model, never sees it. `selectionGateway()` reads it. */
export function attachPlanRequest(state: object, request: PlanRequest): void {
  Object.defineProperty(state, planRequestKey, { value: request })
}

export function readPlanRequest(state: unknown): PlanRequest | undefined {
  return typeof state === "object" && state !== null ? Reflect.get(state, planRequestKey) : undefined
}
