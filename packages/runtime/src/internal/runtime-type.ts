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

function isCallableRepresentation(value: unknown): boolean {
  if (value === null || value === undefined || Object(value) !== value) return false
  try {
    Function.prototype.toString.call(value)
    return true
  }
  catch {
    return false
  }
}

/** Parses JavaScript runtime representation categories at Runtime boundaries. */
export function hasRuntimeType<TType extends keyof RuntimeTypeMap>(
  value: unknown,
  expected: TType,
): value is RuntimeTypeMap[TType] {
  if (expected === "undefined") return value === undefined
  if (expected === "object" && value === null) return true
  if (value === null || value === undefined) return false
  const boxed = Object(value)
  const isPrimitive = boxed !== value
  if (!isPrimitive) {
    if (expected === "function") return isCallableRepresentation(value)
    return expected === "object" && !isCallableRepresentation(value)
  }
  const tag = Object.prototype.toString.call(value)
  switch (expected) {
    case "bigint": return isPrimitive && tag === "[object BigInt]"
    case "boolean": return isPrimitive && tag === "[object Boolean]"
    case "function": return false
    case "number": return isPrimitive && tag === "[object Number]"
    case "object": return false
    case "string": return isPrimitive && tag === "[object String]"
    case "symbol": return isPrimitive && tag === "[object Symbol]"
  }
  throw new TypeError(`Unsupported runtime type: ${expected}`)
}

/** Marks an intentional structural boundary that TypeScript cannot express. */
export function asUnknownBoundary(value: unknown): unknown {
  return value
}

export function isRuntimeObject(value: unknown): value is object {
  return value !== null && Object(value) === value
}
