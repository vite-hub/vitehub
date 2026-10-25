const maximumValueBytes = 256 * 1_024

export interface KVPreview {
  format: "json" | "text"
  truncated?: true
  type: string
  value: string
}

function valueType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (value instanceof Uint8Array) return "bytes"
  return typeof value
}

function truncateValue(value: string): { truncated: boolean; value: string } {
  const encoder = new TextEncoder()
  let bytes = 0
  let end = 0
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength
    if (bytes + characterBytes > maximumValueBytes) {
      return { truncated: true, value: value.slice(0, end) }
    }
    bytes += characterBytes
    end += character.length
  }
  return { truncated: false, value }
}

function boundedJSONStringify(value: unknown): { truncated: boolean; value?: string } {
  let bytes = 0
  let rendered = ""
  let truncated = false
  const encoder = new TextEncoder()
  const ancestors = new Set<object>()

  function append(fragment: string): boolean {
    for (const character of fragment) {
      const characterBytes = encoder.encode(character).byteLength
      if (bytes + characterBytes > maximumValueBytes) {
        truncated = true
        return false
      }
      rendered += character
      bytes += characterBytes
    }
    return true
  }

  function appendString(text: string): boolean {
    if (!append('"')) return false
    for (const character of text) {
      const escaped = JSON.stringify(character).slice(1, -1)
      if (!append(escaped)) return false
    }
    return append('"')
  }

  function serialize(input: unknown, depth: number, arrayValue: boolean, key: string, applyToJSON = true): boolean {
    if (typeof input === "string") return appendString(input)
    if (input === null) return append("null")
    if (typeof input === "number") return append(Number.isFinite(input) ? String(input) : "null")
    if (typeof input === "boolean") return append(input ? "true" : "false")
    if (typeof input === "undefined" || typeof input === "function" || typeof input === "symbol") {
      return arrayValue ? append("null") : false
    }
    if (typeof input === "bigint") {
      const toJSON: unknown = Reflect.get(Object(input), "toJSON")
      if (applyToJSON && typeof toJSON === "function") return serialize(toJSON.call(input, key), depth, arrayValue, key, false)
      throw new TypeError("Cannot serialize bigint as JSON.")
    }

    // SAFETY: Primitive JSON categories returned above, so the remaining input is an object.
    const object = Object(input)
    const toJSON: unknown = Reflect.get(object, "toJSON")
    if (applyToJSON && typeof toJSON === "function") {
      const replacement = toJSON.call(input, key)
      if (replacement !== input) return serialize(replacement, depth, arrayValue, key, false)
    }
    const boxed = input instanceof Number || input instanceof String || input instanceof Boolean || Object.prototype.toString.call(input) === "[object BigInt]"
      ? Reflect.apply(object.valueOf, input, [])
      : input
    if (boxed !== input) return serialize(boxed, depth, arrayValue, key)
    if (ancestors.has(object)) throw new TypeError("Cannot serialize a circular value as JSON.")
    ancestors.add(object)

    if (Array.isArray(object)) {
      if (!append("[")) return false
      for (let index = 0; index < object.length; index += 1) {
        if (!append(`${index === 0 ? "" : ","}\n${"  ".repeat(depth + 1)}`)) return false
        if (!serialize(object[index], depth + 1, true, String(index))) return false
      }
      if (object.length > 0 && !append(`\n${"  ".repeat(depth)}`)) return false
      ancestors.delete(object)
      return append("]")
    }

    if (!append("{")) return false
    let count = 0
    for (const key in object) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) continue
      let item: unknown = Reflect.get(object, key)
      if (item !== null && (typeof item === "object" || typeof item === "bigint")) {
        const toJSON: unknown = Reflect.get(Object(item), "toJSON")
        if (typeof toJSON === "function") item = toJSON.call(item, key)
      }
      if (typeof item === "undefined" || typeof item === "function" || typeof item === "symbol") continue
      if (!append(`${count === 0 ? "" : ","}\n${"  ".repeat(depth + 1)}`)) return false
      if (!appendString(key) || !append(": ") || !serialize(item, depth + 1, false, key, false)) return false
      count += 1
    }
    if (count > 0 && !append(`\n${"  ".repeat(depth)}`)) return false
    ancestors.delete(object)
    return append("}")
  }

  const serialized = serialize(value, 0, false, "")
  return { truncated, value: serialized || truncated ? rendered : undefined }
}

/** A stored value as text of at most 256 KiB, for a page that shows it. Bytes become hex. */
export function previewKVValue(value: unknown): KVPreview {
  const type = valueType(value)
  let format: "json" | "text" = "json"
  let rendered: string
  let truncated = false
  if (typeof value === "string") {
    format = "text"
    rendered = value
  }
  else if (value instanceof Uint8Array) {
    format = "text"
    const maximumBytes = maximumValueBytes / 2
    truncated = value.byteLength > maximumBytes
    rendered = Array.from(value.subarray(0, maximumBytes), byte => byte.toString(16).padStart(2, "0")).join("")
  }
  else {
    try {
      const result = boundedJSONStringify(value)
      rendered = result.value ?? String(value)
      truncated = result.truncated
    }
    catch {
      format = "text"
      rendered = String(value)
    }
  }
  const result = truncateValue(rendered)
  const formatted: KVPreview = {
    format,
    type,
    value: result.value,
  }
  if (truncated || result.truncated) formatted.truncated = true
  return formatted
}

