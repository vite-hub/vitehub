import { isH3V1Event, toH3V1Request } from "@vite-hub/internal/runtime/h3-v1-request"

import type { AuthRequest, AuthRequestInput } from "./types.ts"

/**
 * Return the request of a Web Request, an event with an own `req` request such as H3 2,
 * or an event with an own `node.req` Node request such as H3 1 in Nuxt 4.
 */
export function unwrapAuthRequest(input: AuthRequestInput): AuthRequest {
  if (Object.hasOwn(input, "req")) {
    // SAFETY: AuthRequestInput is a request or an own-property host wrapper; inherited req values must not replace the request.
    return (input as { req: AuthRequest }).req
  }
  if (isH3V1Event(input)) return toH3V1Request(input)
  // SAFETY: The remaining AuthRequestInput branch is the request itself.
  return input as AuthRequest
}
