import { installConsoleAccess } from "../../src/console/runtime/server/access.ts"

// Route tests run as the local development server does. Access tests install their own policy.
installConsoleAccess({ mode: "local" })

/** Call a guarded Console route. Fail when Console access rejects the request. */
export function allowed<TEvent, TResult>(route: (event: TEvent) => Promise<TResult | Response>): (event: TEvent) => Promise<TResult> {
  return async (event) => {
    const result = await route(event)
    if (result instanceof Response) throw new Error(`Console access rejected the request with status ${result.status}.`)
    return result
  }
}
