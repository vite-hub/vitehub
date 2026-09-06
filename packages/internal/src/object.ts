export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || Object(value) !== value || Array.isArray(value)) return false
  try {
    Function.prototype.toString.call(value)
    return false
  }
  catch {
    return true
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype === null) return true
  return Object.getPrototypeOf(prototype) === null
    && Object.hasOwn(prototype, "constructor")
    && prototype.constructor?.name === "Object"
}
