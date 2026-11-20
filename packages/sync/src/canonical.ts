import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"

/** A `JSON.stringify()` replacer that writes a `bigint` as text, so rows with bigint columns go over the wire. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value
}

/** Canonical JSON: object keys sorted, so the same values give the same text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`).join(",")}}`
  }
  return JSON.stringify(value, jsonReplacer) ?? "null"
}

/** Whether two values have the same JSON form, such as a `Date` and its ISO text. */
export function sameValue(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right)
}

/** The JSON form of a value, as it goes over the wire, or `undefined` when it has none, such as a function. */
export function toJson(value: unknown): unknown {
  try {
    const text = JSON.stringify(value, jsonReplacer)
    return text === undefined ? undefined : JSON.parse(text)
  }
  catch {
    // A cycle, or a `toJSON()` that throws: the value has no JSON form.
    return undefined
  }
}

/** The first 32 hex characters of the SHA-256 of `text`. */
export async function fingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 32)
}

/** The account of a user, as the server names it in a pull and the browser on the writes it queues. */
export function accountOf(userId: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(`account\n${userId}`)).subarray(0, 16))
}
