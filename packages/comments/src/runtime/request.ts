import { isH3V1Event, toH3V1Request } from "@vite-hub/internal/runtime/h3-v1-request"

import type { H3Event } from "h3"

/**
 * The Web Request of an event. Nitro 3 events carry it as `req`; the H3 1 events of Nuxt 4's Nitro 2 carry Node's
 * request instead, so this reads one from it.
 */
export function requestOf(event: H3Event): Request {
  const req: unknown = Reflect.get(event, "req")
  if (req instanceof Request) return req
  if (isH3V1Event(event)) return toH3V1Request(event)
  return event.req
}
