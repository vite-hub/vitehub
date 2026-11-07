import type { H3Event } from "h3"

/** The Web Request of an event, which Nitro carries as `req`. */
export function requestOf(event: H3Event): Request {
  return event.req
}
