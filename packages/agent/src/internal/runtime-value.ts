function isPrimitiveRuntimeValue(value: unknown): boolean {
  return value !== null && value !== undefined && Object(value) !== value
}

export function isRuntimeBigInt(value: unknown): value is bigint {
  return isPrimitiveRuntimeValue(value) && Object.prototype.toString.call(value) === "[object BigInt]"
}

export function isRuntimeBoolean(value: unknown): value is boolean {
  return value === true || value === false
}

export function isRuntimeFunction(value: unknown): value is Function {
  if (value === null || Object(value) !== value) return false
  try {
    Function.prototype.toString.call(value)
    return true
  } catch {
    return false
  }
}

export function isRuntimeNumber(value: unknown): value is number {
  return isPrimitiveRuntimeValue(value) && Object.prototype.toString.call(value) === "[object Number]"
}

export function isRuntimeObject(value: unknown): value is object {
  return value !== null && Object(value) === value && !isRuntimeFunction(value)
}

export function isRuntimeString(value: unknown): value is string {
  return isPrimitiveRuntimeValue(value) && Object.prototype.toString.call(value) === "[object String]"
}

export function isRuntimeSymbol(value: unknown): value is symbol {
  return isPrimitiveRuntimeValue(value) && Object.prototype.toString.call(value) === "[object Symbol]"
}

export function isRuntimeUndefined(value: unknown): value is undefined {
  return value === undefined
}
