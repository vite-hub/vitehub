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
      // Some registered Fetch implementations (including node-fetch) expose
      // `headers` as an own instance field rather than a prototype accessor.
      // The registered constructor identity is the provenance check in this
      // case; still require a concrete headers value before accepting it.
      const ownHeaders = Object.getOwnPropertyDescriptor(value as object, "headers")
      if (ownHeaders && !ownHeaders.get && "value" in ownHeaders) {
        if (!ownHeaders.value || (typeof ownHeaders.value !== "object" && typeof ownHeaders.value !== "function")) return false
        // Implementations with own `headers` fields do not expose a headers
        // accessor we can brand-check. Use their inherited body accessor,
        // which reaches the implementation's internal body state and throws
        // for objects fabricated solely from the registered prototype.
        let body: (() => unknown) | undefined
        let bodyPrototype: object | null = registeredConstructor.prototype
        const visitedBodyPrototypes = new Set<object>()
        while (bodyPrototype && !visitedBodyPrototypes.has(bodyPrototype)) {
          visitedBodyPrototypes.add(bodyPrototype)
          const descriptor = Object.getOwnPropertyDescriptor(bodyPrototype, "body")
          if (descriptor) {
            body = descriptor.get
            break
          }
          bodyPrototype = Object.getPrototypeOf(bodyPrototype) as object | null
        }
        if (typeof body !== "function") return false
        // A fabricated registered prototype can copy the public body factory
        // and make the accessor return null without ever running the foreign
        // Response constructor. Body-bearing responses must expose the
        // implementation-created body here; otherwise keep the value generic.
        if (body.call(value) == null) return false
        return true
      }
      // A subclass may inherit the implementation's intrinsic accessor from
      // its registered base prototype. Resolve that accessor through the full
      // prototype chain while retaining the brand check on the candidate.
      let headers: ((this: unknown) => unknown) | undefined
      let prototype: object | null = registeredConstructor.prototype
      const visitedPrototypes = new Set<object>()
      while (prototype && !visitedPrototypes.has(prototype)) {
        visitedPrototypes.add(prototype)
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "headers")
        if (descriptor) {
          headers = descriptor.get
          break
        }
        prototype = Object.getPrototypeOf(prototype) as object | null
      }
      if (typeof headers !== "function") return false
      headers.call(value)
      return true
    }
    catch {
      return false
    }
  }
}
