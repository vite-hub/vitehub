import { getStandardContext } from "@vite-hub/runtime/h3"

import type { ViteHubContext } from "@vite-hub/runtime"

/** The Web Request of an event, from its Standard Context. On the H3 1 events of Nuxt 4, it is built from Node's request. */
export function requestOf(event: ViteHubContext): Request {
  return getStandardContext(event).req
}
