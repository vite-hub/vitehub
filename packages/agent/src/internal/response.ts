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

/** Return the registered Fetch constructor in a candidate's inheritance chain. */
export function findTrustedResponseConstructor(constructor: unknown): Function | undefined {
  let candidate = typeof constructor === "function" ? constructor : undefined
  const visited = new Set<Function>()
  while (candidate && !visited.has(candidate)) {
    visited.add(candidate)
    if (isTrustedResponseConstructor(candidate)) return candidate
    let parent: unknown
    try {
      parent = Object.getPrototypeOf(candidate)
    }
    catch {
      return undefined
    }
    candidate = typeof parent === "function" ? parent : undefined
  }
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
      const registeredConstructor = findTrustedResponseConstructor(constructor)
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
        // Response constructor. Bodyless instances still carry the
        // implementation's own initialization state, so require that state
        // before accepting a null body.
        if (body.call(value) == null) {
          const candidate = value as object
          if (!Object.prototype.hasOwnProperty.call(candidate, "bodyInit")
            || !Object.prototype.hasOwnProperty.call(candidate, "options")
            // The ponyfill initializes these implementation-owned state
            // slots on every instance. Requiring the complete initialized
            // state keeps a prototype copy with only the public body fields
            // from being accepted as a bodyless Response.
            || !Object.prototype.hasOwnProperty.call(candidate, "_generatedBody")
            || !Object.prototype.hasOwnProperty.call(candidate, "_signal")
            || !Object.prototype.hasOwnProperty.call(candidate, "bodyUsed")) return false
          // A bodyless foreign instance cannot provide an unforgeable brand
          // through this structural boundary. Keep null-body candidates on
          // the generic path unless the host intrinsic already authenticated
          // them above.
          return false
        }
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
