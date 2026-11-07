import type { AuthRequest, AuthRequestInput } from "./types.ts"

/** Return the request of a Web Request or of an event with an own `req` request, such as an H3 event. */
export function unwrapAuthRequest(input: AuthRequestInput): AuthRequest {
  if (Object.hasOwn(input, "req")) {
    // SAFETY: AuthRequestInput is a request or an own-property host wrapper; inherited req values must not replace the request.
    return (input as { req: AuthRequest }).req
  }
  // SAFETY: The remaining AuthRequestInput branch is the request itself.
  return input as AuthRequest
}
