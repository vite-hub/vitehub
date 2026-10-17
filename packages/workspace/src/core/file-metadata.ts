import { workspaceError } from "./errors.ts"

// Validate without invoking getters or toJSON hooks that can change ownership.
function copyJsonValue(value: unknown, ancestors: Set<object>, normalizeOptional = false): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value
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

export function copyJsonWorkspaceMetadata(path: string, metadata: Record<string, unknown> | undefined, normalizeOptional = false): Record<string, unknown> | undefined {
  if (metadata === undefined) return
  let copy: Record<string, unknown> | undefined
  try {
    if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
      // SAFETY: The non-null, non-array input is copied into a plain object; copyJsonValue rejects unsupported prototypes and recursively validates every property.
      copy = copyJsonValue(metadata, new Set(), normalizeOptional) as Record<string, unknown>
    }
  }
  catch { /* Deep or exotic objects are not a portable metadata representation. */ }
  if (!copy) throw workspaceError(`[vitehub] Invalid Workspace metadata for ${path}. Metadata must contain only JSON-safe plain objects, dense arrays, strings, booleans, null, and finite numbers other than negative zero.`)
  return copy
}

export function copyJsonFileMetadata(path: string, metadata: Record<string, unknown> | undefined, normalizeOptional = false): Record<string, unknown> | undefined {
  const copy = copyJsonWorkspaceMetadata(path, metadata, normalizeOptional)
  if (!copy) return
  const source = Object.getOwnPropertyDescriptor(copy, "source")
  if (source && typeof source.value !== "string") {
    throw workspaceError(`[vitehub] Invalid Workspace metadata for ${path}. metadata.source must be a string when provided.`)
  }
  return copy
}
