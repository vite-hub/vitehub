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
      if (typeof constructor !== "function") return false
      // Walk the constructor inheritance chain so subclasses of a registered
      // Fetch implementation retain its intrinsic internal-state brand check.
      // `instanceof` alone accepts Object.create(Response.prototype), which
      // has none of the implementation's internal state.
      let registeredConstructor: Function | undefined
      let candidate: Function | undefined = constructor
      const visitedConstructors = new Set<Function>()
      while (candidate && !visitedConstructors.has(candidate)) {
        visitedConstructors.add(candidate)
        if (isTrustedResponseConstructor(candidate)) {
          registeredConstructor = candidate
          break
        }
        const parent = Object.getPrototypeOf(candidate)
        candidate = typeof parent === "function" ? parent : undefined
      }
      if (!registeredConstructor) return false
      const headers = Object.getOwnPropertyDescriptor(registeredConstructor.prototype, "headers")?.get
      if (typeof headers !== "function") return false
      headers.call(value)
      return true
    }
    catch {
      return false
    }
  }
}
