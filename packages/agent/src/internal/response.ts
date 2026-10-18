// Use the host Fetch implementation's intrinsic, not properties supplied by the
// invocation. This supports realms sharing that implementation without accepting
// tags, copied methods, or objects inheriting Response.prototype. Unrelated Fetch
// implementations must be converted to the host Response at their adapter boundary.
const responseHeaders = Object.getOwnPropertyDescriptor(Response.prototype, "headers")?.get
const trustedResponseConstructors = new WeakSet<Function>([Response])

/** Register an independently implemented Fetch Response constructor at an adapter boundary. */
export function registerResponseConstructor(constructor: Function): void {
  trustedResponseConstructors.add(constructor)
}

export function isTrustedResponseConstructor(constructor: unknown): constructor is Function {
  return typeof constructor === "function" && trustedResponseConstructors.has(constructor)
}

export function isResponse(value: unknown): value is Response {
  try {
    if (!responseHeaders) return false
    responseHeaders.call(value)
    return true
  }
  catch {
    try {
      const constructor = (value as { constructor?: unknown }).constructor
      return isTrustedResponseConstructor(constructor) && value instanceof (constructor as Function)
    }
    catch {
      return false
    }
  }
}
