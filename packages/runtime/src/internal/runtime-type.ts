import { runtimeErrorDiagnostics } from "../error-diagnostics.ts"

export { runtimeErrorDiagnostics }
type RuntimeTypeMap = {
  bigint: bigint
  boolean: boolean
  function: CallableFunction
  number: number
  object: object | null
  string: string
  symbol: symbol
  undefined: undefined
}

/** Narrows opaque inputs without reading their properties. Kept for `@vite-hub/presets`; other packages use `typeof`. */
export function hasRuntimeType<TType extends keyof RuntimeTypeMap>(
  value: unknown,
  expected: TType,
): value is RuntimeTypeMap[TType] {
  switch (expected) {
    case "bigint":
    case "boolean":
    case "function":
    case "number":
    case "object":
    case "string":
    case "symbol":
    case "undefined": {
      const representation = typeof value
      // Callable HTMLDDA browser values report undefined without being undefined.
      return (representation === "undefined" && value !== undefined ? "function" : representation) === expected
    }
  }
  throw runtimeErrorDiagnostics.RUNTIME_R0008({ message: `Unsupported runtime type: ${expected}` })
}

/** Marks an intentional structural boundary that TypeScript cannot express. */
export function asUnknownBoundary(value: unknown): unknown {
  return value
}

export function isRuntimeObject(value: unknown): value is object {
  return value !== null && Object(value) === value
}

/** Whether a value is an object literal or a null-prototype record. A built-in object whose prototype code replaced reads as one. */
function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** The native Response class and its `status` getter, and the proxy check of Node.js. Read once, at import. */
function captureResponseChecks() {
  const response: unknown = globalThis.Response
  return {
    response,
    status: typeof response === "function" ? Object.getOwnPropertyDescriptor(Response.prototype, "status")?.get : undefined,
    // Node.js 22 runs the Response brand check through a Proxy. Node.js 24 does not.
    isProxy: globalThis.process?.getBuiltinModule?.("node:util")?.types.isProxy,
  }
}

// Pure, so a bundle that never checks a Response drops the capture.
const nativeResponseChecks = /* @__PURE__ */ captureResponseChecks()

/**
 * The `status` getter of the global `Response` when a server replaced the native class. srvx, which Nitro uses on Node.js,
 * installs its own `Response` class, so `Response.json()` in app code and in ViteHub returns an instance of that class.
 * Its getters read private fields, so they check the brand like the native getter does.
 */
function replacedResponseStatus(): ((this: unknown) => unknown) | undefined {
  const current: unknown = globalThis.Response
  if (typeof current !== "function" || current === nativeResponseChecks.response) return undefined
  const prototype: unknown = Reflect.get(current, "prototype")
  return isRuntimeObject(prototype) ? Object.getOwnPropertyDescriptor(prototype, "status")?.get : undefined
}

/**
 * Return whether `value` is a Response of this runtime: of the native class, or of the class that the server installed
 * as the global `Response`.
 * The `status` getter checks the internal Response slot, so a copied prototype, an object tagged `Response`,
 * and a Response from another Fetch implementation all fail. A proxy fails too. The check reads no property of `value`.
 */
export function isRuntimeResponse(value: unknown): value is Response {
  if (value === null || typeof value !== "object" || nativeResponseChecks.isProxy?.(value)) return false
  // A failed brand check throws, and each TypeError captures a stack trace. An array, an object literal, or a
  // null-prototype record skips both checks. Where `isProxy` is missing, this would run the getPrototypeOf trap of a
  // proxy, so it runs only with `isProxy`.
  if (nativeResponseChecks.isProxy !== undefined && (Array.isArray(value) || isPlainRecord(value))) return false
  for (const status of [nativeResponseChecks.status, replacedResponseStatus()]) {
    if (!status) continue
    try {
      Reflect.apply(status, value, [])
      return true
    }
    catch {}
  }
  return false
}
