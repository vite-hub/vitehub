// Use the host Fetch implementation's intrinsic, not properties supplied by the
// invocation. This supports realms sharing that implementation without accepting
// tags, copied methods, or objects inheriting Response.prototype. Unrelated Fetch
// implementations must be converted to the host Response at their adapter boundary.
const responseHeaders = Object.getOwnPropertyDescriptor(Response.prototype, "headers")?.get

export function isResponse(value: unknown): value is Response {
  try {
    if (!responseHeaders) return false
    responseHeaders.call(value)
    return true
  }
  catch {
    return false
  }
}
