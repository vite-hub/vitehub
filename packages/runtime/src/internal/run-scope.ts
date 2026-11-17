/** Wraps one unit of work, such as a Schedule run or a Queue job. It calls `run` once and passes on its error. */
export type RunScope = (run: () => Promise<void>) => Promise<unknown>

// Every copy of this package in one process shares the scopes, so a primitive bundled twice still sees them.
const scopesKey = Symbol.for("vitehub.runtime.runScopes")

function scopes(): Set<RunScope> {
  const runtimeGlobal = globalThis as typeof globalThis & { [scopesKey]?: Set<RunScope> }
  return runtimeGlobal[scopesKey] ??= new Set()
}

/**
 * Adds a scope that wraps each Schedule run and Queue job. Workspace adds one, so a run that throws drops the writes it
 * staged in a cached Store. Adding the same scope again does nothing.
 */
export function registerRunScope(scope: RunScope): void {
  scopes().add(scope)
}

/** Runs one Schedule run or Queue job inside every registered scope. A Nitro request gets its scopes from middleware. */
export async function runInRunScopes<T>(run: () => T | Promise<T>): Promise<T> {
  let result!: T
  let next = async () => {
    result = await run()
  }
  for (const scope of scopes()) {
    const inner = next
    next = async () => {
      await scope(inner)
    }
  }
  await next()
  return result
}
