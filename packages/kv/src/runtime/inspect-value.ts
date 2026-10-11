import * as v from "valibot"

class UnsupportedValueError extends Error {}

function isUint8Array(value: unknown): value is Uint8Array {
  if (!ArrayBuffer.isView(value)) return false
  try {
    // The byte-length/element-length check rejects wider typed arrays and
    // DataView before consulting the cross-realm tag. Keep the tag access
    // guarded because Symbol.toStringTag may be hostile.
    return "length" in value && value.byteLength === value.length && Object.prototype.toString.call(value) === "[object Uint8Array]"
  }
  catch {
    return false
  }
}

export function kvValueType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (isUint8Array(value)) return "bytes"
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- This reports the stored value representation; it does not validate an input contract.
  return typeof value
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let index = 0; index < bytes.byteLength; index++) binary += String.fromCharCode(bytes[index]!)
  return btoa(binary)
}

/** JSON inspection accepts JSON values and represents bigint values as decimal strings. */
function inspectValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (v.is(v.bigint(), value)) return value.toString()
  if (v.is(v.union([v.null(), v.string(), v.boolean(), v.pipe(v.number(), v.finite())]), value) && !Object.is(value, -0)) return value
  if (!v.is(v.custom<object>(value => value !== null && Object(value) === value), value) || seen.has(value)) {
    throw new UnsupportedValueError()
  }
  seen.add(value)
  try {
    const ownKeys = Reflect.ownKeys(value)
    const dataKeys = Array.isArray(value) ? ownKeys.filter(key => key !== "length") : ownKeys
    const descriptors = dataKeys.map(key => Object.getOwnPropertyDescriptor(value, key))
    if (descriptors.some(descriptor => !descriptor?.enumerable || !("value" in descriptor))) {
      throw new UnsupportedValueError()
    }
    if (Array.isArray(value)) {
      if (dataKeys.length !== value.length || dataKeys.some(key => !v.is(v.string(), key) || String(Number(key)) !== key || !Number.isInteger(Number(key)) || Number(key) < 0 || Number(key) >= value.length)) {
        throw new UnsupportedValueError()
      }
      return Array.from({ length: value.length }, (_, index) => inspectValue(Object.getOwnPropertyDescriptor(value, String(index))?.value, seen))
    }
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) {
      throw new UnsupportedValueError()
    }
    return Object.fromEntries(dataKeys.map(key => [key, inspectValue(Object.getOwnPropertyDescriptor(value, key)?.value, seen)]))
  }
  finally { seen.delete(value) }
}

/** Encodes one inspection result without running getters or exposing non-JSON object behavior. */
export function inspectKVValue(value: unknown): { encoding?: "base64", type: string, value: unknown } | undefined {
  if (isUint8Array(value)) return { encoding: "base64", type: "bytes", value: encodeBase64(value) }
  try {
    return { type: kvValueType(value), value: inspectValue(value) }
  }
  catch (error) {
    if (error instanceof UnsupportedValueError) return
    throw error
  }
}
