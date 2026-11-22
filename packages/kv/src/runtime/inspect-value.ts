import { kvErrorDiagnostics } from "../error-diagnostics.ts"

const unsupported = () => kvErrorDiagnostics.KV_VALUE_UNSUPPORTED()

export function isUint8Array(value: unknown): value is Uint8Array {
  try {
    if (!ArrayBuffer.isView(value)) return false
    const tagGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get
    return Boolean(tagGetter && Reflect.apply(tagGetter, value, []) === "Uint8Array")
  }
  catch {
    return false
  }
}

export function kvValueType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (isUint8Array(value)) return "bytes"
  return typeof value
}

function encodeBase64(bytes: Uint8Array): string {
  try {
    const lengthGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "length")?.get
    if (!lengthGetter) throw unsupported()
    const length = Reflect.apply(lengthGetter, bytes, [])
    for (const key of ["byteLength", "length"]) {
      const descriptor = Object.getOwnPropertyDescriptor(bytes, key)
      if (descriptor && (!("value" in descriptor) || descriptor.value !== length)) throw unsupported()
    }
    const encoded: string[] = []
    let chunk: number[] = []
    for (const byte of Reflect.apply(Uint8Array.prototype.values, bytes, [])) {
      chunk.push(byte)
      if (chunk.length === 12_288) {
        encoded.push(btoa(String.fromCharCode(...chunk)))
        chunk = []
      }
    }
    if (chunk.length) encoded.push(btoa(String.fromCharCode(...chunk)))
    return encoded.join("")
  }
  catch {
    throw unsupported()
  }
}

function inspectValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "bigint") return value.toString()
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value
  if ((typeof value !== "object" && typeof value !== "function") || seen.has(value)) {
    throw unsupported()
  }
  seen.add(value)
  try {
    const ownKeys = Reflect.ownKeys(value)
    const dataKeys = Array.isArray(value) ? ownKeys.filter(key => key !== "length") : ownKeys
    const descriptors = dataKeys.map(key => Object.getOwnPropertyDescriptor(value, key))
    if (descriptors.some(descriptor => !descriptor?.enumerable || !("value" in descriptor))) {
      throw unsupported()
    }
    if (Array.isArray(value)) {
      if (dataKeys.length !== value.length || dataKeys.some(key => typeof key !== "string" || String(Number(key)) !== key || !Number.isInteger(Number(key)) || Number(key) < 0 || Number(key) >= value.length)) {
        throw unsupported()
      }
      return Array.from({ length: value.length }, (_, index) => inspectValue(Object.getOwnPropertyDescriptor(value, String(index))?.value, seen))
    }
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) {
      throw unsupported()
    }
    return Object.fromEntries(dataKeys.map(key => [key, inspectValue(Object.getOwnPropertyDescriptor(value, key)?.value, seen)]))
  }
  finally { seen.delete(value) }
}

/** Encodes one inspection result without running getters or exposing non-JSON object behavior. */
export function inspectKVValue(value: unknown): { encoding?: "base64", type: string, value: unknown } | undefined {
  try {
    if (isUint8Array(value)) return { encoding: "base64", type: "bytes", value: encodeBase64(value) }
    return { type: kvValueType(value), value: inspectValue(value) }
  }
  catch (error) {
    if (Reflect.get(Object(error), "code") === "KV_VALUE_UNSUPPORTED") return
    throw error
  }
}
