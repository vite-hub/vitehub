import { workspaceError } from "./errors.ts"

// Validate without invoking getters or toJSON hooks that can change ownership.
function copyJsonValue(value: unknown, ancestors: Set<object>, normalizeOptional = false): unknown {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- This boundary validates JSON primitives without invoking user getters or serialization hooks.
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Only objects can enter descriptor traversal; functions and other non-JSON primitives are invalid.
  if (typeof value !== "object" || ancestors.has(value)) throw new Error("Invalid JSON metadata")
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (!array && prototype !== Object.prototype && prototype !== null) throw new Error("Invalid JSON metadata")
  ancestors.add(value)
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors).filter(key => !array || key !== "length")
    if (array && !normalizeOptional && keys.length !== descriptors.length?.value) throw new Error("Invalid JSON metadata")
    const copy = array ? [] : {}
    for (const [index, key] of keys.entries()) {
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- JSON keys must be strings; symbols cannot survive serialization.
      if (typeof key !== "string" || (array && (normalizeOptional ? !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= descriptors.length?.value : key !== String(index)))) throw new Error("Invalid JSON metadata")
      const descriptor = descriptors[key]!
      if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("Invalid JSON metadata")
      if (normalizeOptional && descriptor.value === undefined && !array) continue
      Object.defineProperty(copy, key, {
        value: normalizeOptional && descriptor.value === undefined ? null : copyJsonValue(descriptor.value, ancestors, normalizeOptional), enumerable: true, writable: true, configurable: true,
      })
    }
    if (array && normalizeOptional) {
      for (let index = 0; index < descriptors.length?.value; index++) {
        if (!Object.hasOwn(copy, index)) Object.defineProperty(copy, index, { value: null, enumerable: true, writable: true, configurable: true })
      }
    }
    return copy
  }
  finally {
    ancestors.delete(value)
  }
}

export function copyJsonFileMetadata(path: string, metadata: Record<string, unknown> | undefined, normalizeOptional = false): Record<string, unknown> | undefined {
  if (metadata === undefined) return
  let copy: Record<string, unknown> | undefined
  try {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Reject non-object JavaScript inputs before recursively validating the metadata contract.
    if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
      // SAFETY: The non-null, non-array input is copied into a plain object; copyJsonValue rejects unsupported prototypes and recursively validates every property.
      copy = copyJsonValue(metadata, new Set(), normalizeOptional) as Record<string, unknown>
    }
  }
  catch { /* Deep or exotic objects are not a portable metadata representation. */ }
  if (!copy) throw workspaceError(`[vitehub] Invalid Workspace metadata for ${path}. File metadata must contain only JSON-safe plain objects, dense arrays, strings, booleans, null, and finite numbers other than negative zero.`)
  const source = Object.getOwnPropertyDescriptor(copy, "source")
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Source ownership is a reserved string field at the shared metadata boundary.
  if (source && typeof source.value !== "string") {
    throw workspaceError(`[vitehub] Invalid Workspace metadata for ${path}. metadata.source must be a string when provided.`)
  }
  return copy
}
