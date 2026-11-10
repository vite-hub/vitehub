/** A non-null object that is not an array. Functions do not pass. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A non-null object or a function that is not an array. */
export function isRecordOrFunction(value: unknown): value is Record<string, unknown> {
  return Object(value) === value && !Array.isArray(value)
}

export { isRecord as isPlainObject }

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype === null) return true
  return Object.getPrototypeOf(prototype) === null
    && Object.hasOwn(prototype, "constructor")
    && prototype.constructor?.name === "Object"
}
