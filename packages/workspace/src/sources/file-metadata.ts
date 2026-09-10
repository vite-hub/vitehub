export function normalizeMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeMetadataValue)
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return value
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, normalizeMetadataValue(entry)]))
}


// Source objects may contain absent optional fields; Stores persist JSON metadata.
export function normalizeSourceFileMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, normalizeMetadataValue(value)]))
}
