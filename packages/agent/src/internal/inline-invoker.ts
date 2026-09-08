import { isRuntimeObject } from "./runtime-value.ts"

export function sameInlineInvoker(left: unknown, right: unknown, pairs = new Map<object, object>()): boolean {
  if (Object.is(left, right)) return true
  if (!isRuntimeObject(left) || !isRuntimeObject(right)) return false
  if (pairs.has(left)) return pairs.get(left) === right
  if ([...pairs.values()].includes(right)) return false
  try {
    const prototype = Object.getPrototypeOf(left)
    if (prototype !== Object.getPrototypeOf(right)) return false
    // Compare record and array contents without invoking accessors or toJSON.
    // Other object types, functions, and symbols retain reference identity.
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return false
    const keys = Reflect.ownKeys(left)
    if (keys.length !== Reflect.ownKeys(right).length) return false
    pairs.set(left, right)
    return keys.every((key) => {
      const a = Object.getOwnPropertyDescriptor(left, key)
      const b = Object.getOwnPropertyDescriptor(right, key)
      return !!a && !!b && "value" in a && "value" in b && sameInlineInvoker(a.value, b.value, pairs)
    })
  } catch {
    return false
  }
}
