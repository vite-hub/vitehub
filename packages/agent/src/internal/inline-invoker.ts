import { isRuntimeObject } from "./runtime-value.ts"

export function sameInlineInvoker(left: unknown, right: unknown, pairs = new Map<object, object>()): boolean {
  if (Object.is(left, right)) return true
  if (!isRuntimeObject(left) || !isRuntimeObject(right)) return false
  if (pairs.has(left)) return pairs.get(left) === right
  if ([...pairs.values()].includes(right)) return false
  try {
    const prototype = Object.getPrototypeOf(left)
    if (prototype !== Object.getPrototypeOf(right)) return false
    pairs.set(left, right)
    // Read Date's internal value without calling user overrides, then compare
    // its own metadata with the same descriptor rules as records and arrays.
    if (prototype === Date.prototype) {
      if (!Object.is(Date.prototype.getTime.call(left), Date.prototype.getTime.call(right))) return false
    } else if (prototype === Map.prototype || prototype === Set.prototype) {
      const entries = (value: unknown) => prototype === Map.prototype
        ? [...Map.prototype.entries.call(value)]
        : [...Set.prototype.entries.call(value)]
      const a = entries(left)
      const b = entries(right)
      if (!sameInlineInvoker(a, b, pairs)) return false
    } else if (prototype === RegExp.prototype) {
      for (const key of ["source", "global", "ignoreCase", "multiline", "dotAll", "unicode", "sticky", "hasIndices", "unicodeSets"]) {
        const get = Object.getOwnPropertyDescriptor(RegExp.prototype, key)?.get
        if (get && !Object.is(get.call(left), get.call(right))) return false
      }
    } else if (prototype === URL.prototype) {
      const get = Object.getOwnPropertyDescriptor(URL.prototype, "href")!.get!
      if (get.call(left) !== get.call(right)) return false
    } else if (prototype === ArrayBuffer.prototype || (ArrayBuffer.isView(left) && ArrayBuffer.isView(right))) {
      const bytes = (value: unknown) => {
        if (prototype === ArrayBuffer.prototype) {
          const length = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!.call(value)
          // SAFETY: The intrinsic byteLength getter above rejects values without ArrayBuffer internal slots.
          return new Uint8Array(value as ArrayBuffer, 0, length)
        }
        const viewPrototype = prototype === DataView.prototype ? DataView.prototype : Object.getPrototypeOf(Uint8Array.prototype)
        const read = (key: string) => Object.getOwnPropertyDescriptor(viewPrototype, key)!.get!.call(value)
        return new Uint8Array(read("buffer"), read("byteOffset"), read("byteLength"))
      }
      const a = bytes(left)
      const b = bytes(right)
      if (a.length !== b.length || !a.every((value, index) => value === b[index])) return false
    } else if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
      // Unsupported objects, functions, and symbols retain reference identity.
      return false
    }
    const keys = Reflect.ownKeys(left)
    if (keys.length !== Reflect.ownKeys(right).length) return false
    return keys.every((key) => {
      const a = Object.getOwnPropertyDescriptor(left, key)
      const b = Object.getOwnPropertyDescriptor(right, key)
      return !!a && !!b && "value" in a && "value" in b && sameInlineInvoker(a.value, b.value, pairs)
    })
  } catch {
    return false
  }
}
