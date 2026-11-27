export function isRuntimeRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null
}

export function isRuntimeObject(value: unknown): value is object {
  return value !== null && Object(value) === value
}

/**
 * Whether a value is a primitive, an object literal, or a null-prototype record. An intrinsic brand check, such as
 * `Date.prototype.getTime.call(value)`, throws for such a value, and each thrown TypeError captures a stack trace.
 * Callers skip those checks for it. A built-in object whose prototype code replaced with Object.prototype or null
 * reads as a record.
 */
export function isUnbrandedValue(value: unknown): boolean {
  if (!isRuntimeObject(value)) return true
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  }
  catch {
    return false
  }
}

/** Marks an intentional structural boundary that TypeScript cannot express. */
export function asUnknownBoundary(value: unknown): unknown {
  return value
}
