const valueIds = new WeakMap<object, number>()
let nextValueId = 0

function identityKey(value: object): string {
  let id = valueIds.get(value)
  if (id === undefined) valueIds.set(value, id = nextValueId++)
  return `#${id}`
}

function isPlainData(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)
  return Array.isArray(value) ? prototype === Array.prototype : prototype === Object.prototype || prototype === null
}

/** Write the key of `value` to `parts`. Returns false for a value that gives no key. */
function writeKey(value: unknown, parts: string[], parents: Set<object>): boolean {
  if (typeof value === "symbol") return false
  if (typeof value === "string") {
    parts.push(JSON.stringify(value))
    return true
  }
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    parts.push(`${typeof value}:${String(value)}`)
    return true
  }
  const descriptors = isPlainData(value) && !parents.has(value) ? Object.getOwnPropertyDescriptors(value) : undefined
  // Getters, symbol keys, and cycles are not read: the object itself is the key.
  if (!descriptors || Object.getOwnPropertySymbols(descriptors).length > 0 || Object.values(descriptors).some(descriptor => !("value" in descriptor))) {
    parts.push(identityKey(value))
    return true
  }
  parents.add(value)
  parts.push(Array.isArray(value) ? "[" : "{")
  for (const [name, descriptor] of Object.entries(descriptors)) {
    parts.push(JSON.stringify(name), ":")
    if (!writeKey(descriptor.value, parts, parents)) return false
    parts.push(",")
  }
  parts.push(Array.isArray(value) ? "]" : "}")
  parents.delete(value)
  return true
}

/**
 * A key that is equal only for values that Better Auth gets as equal options. Plain objects and arrays compare by
 * value. Functions, class instances, and bindings compare by identity, so a value that one request creates, such as an
 * adapter for its Cloudflare bindings, never gives its instance to another request. A symbol gives no key.
 */
export function optionsKey(value: unknown): string | undefined {
  const parts: string[] = []
  return writeKey(value, parts, new Set()) ? parts.join("") : undefined
}
