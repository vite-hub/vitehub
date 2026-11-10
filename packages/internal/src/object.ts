export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || Object(value) !== value || Array.isArray(value)) return false
  return typeof value === "object"
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype === null) return true
  return Object.getPrototypeOf(prototype) === null
    && Object.hasOwn(prototype, "constructor")
    && prototype.constructor?.name === "Object"
}

/** A shallow copy of a non-array object, or an empty object for any other value. */
export function cloneRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {}
}
