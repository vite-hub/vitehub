import { invariantError } from "@vite-hub/internal/invariant"
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
      return (representation === "undefined" && value !== undefined ? "function" : representation) === expected
    }
  }
  throw invariantError(`hasRuntimeType() receives only a key of RuntimeTypeMap, not ${String(expected)}`)
}

/** Marks an intentional structural boundary that TypeScript cannot express. */
export function asUnknownBoundary(value: unknown): unknown {
  return value
}

export function isRuntimeObject(value: unknown): value is object {
  return value !== null && Object(value) === value
}

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function captureResponseChecks() {
  const response: unknown = globalThis.Response
  return {
    response,
    status: typeof response === "function" ? Object.getOwnPropertyDescriptor(Response.prototype, "status")?.get : undefined,
    isProxy: globalThis.process?.getBuiltinModule?.("node:util")?.types.isProxy,
  }
}

const nativeResponseChecks = /* @__PURE__ */ captureResponseChecks()

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
