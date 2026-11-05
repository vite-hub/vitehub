import { getStandardContext } from "@vite-hub/runtime/h3"

import type { H3Event } from "h3"

/** The Web Request of an event, from its Standard Context. On the H3 1 events of Nuxt 4, it is built from Node's request. */
export function requestOf(event: H3Event): Request {
  return getStandardContext(event).req
}
