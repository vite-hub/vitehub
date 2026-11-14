import { blobHmacKey, hex } from "./fs-sign.ts"

/** The `deriveSecret()` purpose of the key that signs direct upload tickets. */
export const blobUploadTicketPurpose = "vitehub:blob:direct-upload"

/** What the `complete` step of a direct upload may finish: one pathname, in one store, on one route, until `expires`. */
export interface BlobUploadTicket {
  contentType: string
  /** The selected store name, authenticated before any storage operation. */
  store: string
  /** Seconds since the epoch. */
  expires: number
  pathname: string
  /** The URL path of the upload route, so a ticket from one route cannot finish an upload on another. */
  route: string
}

const encoder = new TextEncoder()

function key() {
  return blobHmacKey(blobUploadTicketPurpose, "Direct uploads")
}

function toBase64Url(value: string): string {
  const bytes = encoder.encode(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function fromBase64Url(value: string): string | undefined {
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"))
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, character => character.charCodeAt(0)))
  }
  catch {
    return undefined
  }
}

/** Signs a ticket. The client sends it back unchanged to the `complete` step. */
export async function sealUploadTicket(ticket: BlobUploadTicket): Promise<string> {
  const body = toBase64Url(JSON.stringify(["v2", ticket.store, ticket.route, ticket.pathname, ticket.contentType, ticket.expires]))
  return `${body}.${hex(await globalThis.crypto.subtle.sign("HMAC", await key(), encoder.encode(body)))}`
}

/** Reads a ticket. Returns `"expired"` for an expired ticket, and `undefined` when the signature does not match. */
export async function openUploadTicket(value: string, now = Date.now()): Promise<BlobUploadTicket | "expired" | undefined> {
  const [body = "", signature = "", ...rest] = value.split(".")
  if (rest.length || !/^[\da-f]{64}$/.test(signature)) return undefined
  const valid = await globalThis.crypto.subtle.verify(
    "HMAC",
    await key(),
    Uint8Array.from(signature.match(/../g)!, byte => Number.parseInt(byte, 16)),
    encoder.encode(body),
  )
  if (!valid) return undefined
  const json = fromBase64Url(body)
  let parts: unknown
  try {
    parts = json === undefined ? undefined : JSON.parse(json)
  }
  catch {
    return undefined
  }
  if (!Array.isArray(parts) || parts[0] !== "v2") return undefined
  const [, store, route, pathname, contentType, expires] = parts
  if (typeof store !== "string" || typeof route !== "string" || typeof pathname !== "string" || typeof contentType !== "string" || typeof expires !== "number") return undefined
  if (expires * 1000 <= now) return "expired"
  return { store, contentType, expires, pathname, route }
}
