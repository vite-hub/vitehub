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
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- This shared guard classifies opaque JavaScript inputs without coercion or exceptions.
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
