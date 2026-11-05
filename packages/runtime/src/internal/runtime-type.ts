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

/** Narrows opaque inputs without reading their properties. */
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

const nativeResponseStatus = hasRuntimeType(globalThis.Response, "function")
  ? Object.getOwnPropertyDescriptor(Response.prototype, "status")?.get
  : undefined
// Node.js 22 runs the Response brand check through a Proxy. Node.js 24 does not.
const isProxy = globalThis.process?.getBuiltinModule?.("node:util")?.types.isProxy

/**
 * Return whether `value` is a Response of this runtime.
 * The native `status` getter checks the internal Response slot, so a copied prototype, an object tagged `Response`,
 * and a Response from another Fetch implementation all fail. A proxy fails too. The check reads no property of `value`.
 */
export function isRuntimeResponse(value: unknown): value is Response {
  if (!nativeResponseStatus || value === null || !hasRuntimeType(value, "object") || isProxy?.(value)) return false
  try {
    Reflect.apply(nativeResponseStatus, value, [])
    return true
  }
  catch {
    return false
  }
}
