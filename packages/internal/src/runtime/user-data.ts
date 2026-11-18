/**
 * The rows that a Server Primitive keeps for one Auth user, such as the comments that the user wrote. The owner package
 * registers them when the server starts. Auth deletes them when the user deletes the account (`deleteAccount`).
 */
export interface ViteHubUserData {
  /** The owner package, such as `comments`. It replaces an earlier registration of the same owner. */
  owner: string
  /** The tables that hold the rows. */
  tables: readonly string[]
  /** Deletes the rows of one user. A user without rows is not an error. */
  delete: (userId: string) => Promise<void>
}

const stateKey: unique symbol = Symbol.for("vitehub.user-data")
// SAFETY: This module owns the process slot. Owner packages bundle their own copy of it, so the registry must be shared
// through the slot, not through module state.
const scope = globalThis as typeof globalThis & { [stateKey]?: WeakMap<object, Map<string, ViteHubUserData>> }

export function registerViteHubUserData(app: unknown, data: ViteHubUserData): void {
  if (!app || typeof app !== "object") return
  const apps = scope[stateKey] ??= new WeakMap()
  let owners = apps.get(app)
  if (!owners) apps.set(app, owners = new Map())
  owners.set(data.owner, data)
}

/** The registered owners, by owner name. */
export function viteHubUserData(app: object | undefined): ViteHubUserData[] {
  const owners = app && scope[stateKey]?.get(app)
  return [...owners?.values() ?? []].sort((left, right) => left.owner.localeCompare(right.owner))
}
