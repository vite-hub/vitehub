import { installStandardContext } from "@vite-hub/runtime/h3"

import type { ViteHubContext } from "@vite-hub/runtime"

/** An H3 2 event shape for `request`, with Standard Context set as the ViteHub Nitro plugin sets it. */
export function requestEvent(request: Request, env?: Record<string, unknown>): ViteHubContext {
  const event = { req: request, res: { headers: new Headers() }, ...(env ? { env } : {}) }
  installStandardContext(event)
  return event
}
