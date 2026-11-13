import { deriveViteHubSecret, readViteHubSecret, viteHubSecretMinimumLength } from "@vite-hub/internal/secret"
import { getViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"

import type { BlobSignedRequest, BlobSignOptions } from "../types.ts"
import { blobErrorDiagnostics } from "../error-diagnostics.ts"
import { blobSizeToBytes } from "./size.ts"

/** The `deriveSecret()` purpose of the key that signs the links of `fs` stores. */
export const blobSignPurpose = "vitehub:blob:sign"

/** The route that answers the links of `fs` stores. ViteHub mounts it only when a store uses the `fs` driver. */
export const blobSignedRoute = "/_vitehub/blob/signed"

/** What a link binds. The URL carries each part, and the signature covers all of them. */
export interface SignedFsLink {
  contentType: string
  expires: string
  maxSize: string
  method: string
  /** The pathname as `sign()` checked it. */
  pathname: string
  store: string
}

/** A request that matches its link. `path` is the pathname as the URL encodes it, which `serve()` and `put()` read. */
export interface VerifiedFsRequest {
  contentType?: string
  maxSize?: number
  method: "GET" | "PUT"
  path: string
  store: string
}

const encoder = new TextEncoder()
type HmacKey = ReturnType<typeof globalThis.crypto.subtle.importKey>

let signingKey: { key: HmacKey, root: string } | undefined

// Every instance derives the same key from the root secret, so a link that one instance signs works on another.
// A key per process would break links after a restart and between instances.
function hmacKey(): HmacKey {
  const root = readViteHubSecret({ ...globalThis.process?.env, ...getViteHubTestMode()?.env })
  if (!root || root.length < viteHubSecretMinimumLength) {
    throw blobErrorDiagnostics.BLOB_R0040({
      message: root
        ? `The links of \`fs\` stores need a VITEHUB_SECRET of at least ${viteHubSecretMinimumLength} characters.`
        : "The links of `fs` stores need VITEHUB_SECRET or NUXT_APP_SECRET in the runtime environment.",
    })
  }
  if (signingKey?.root !== root) {
    const key = deriveViteHubSecret(root, blobSignPurpose).then(secret => globalThis.crypto.subtle.importKey(
      "raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign", "verify"],
    ))
    signingKey = { key, root }
  }
  return signingKey.key
}

// JSON keeps the parts apart, so a pathname cannot pass for another pathname followed by other parts.
function payload(link: SignedFsLink): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(["v1", link.method, link.store, link.pathname, link.expires, link.contentType, link.maxSize]))
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("")
}

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  }
  catch {
    return undefined
  }
}

/**
 * Signs a link to the signed route for one object of an `fs` store, as a provider signs its own URL. Expects a
 * pathname that `sign()` checked. A `PUT` link binds its content type and its largest body.
 */
export async function signFsRequest(store: string, pathname: string, options: BlobSignOptions, urlBaseUrl = ""): Promise<BlobSignedRequest> {
  if (options.method === "PUT" && options.createOnly) {
    throw blobErrorDiagnostics.BLOB_R0025({ message: "Blob driver \"fs\" cannot bind `createOnly` to a signed request." })
  }
  const contentType = options.method === "PUT" ? options.contentType ?? "" : ""
  const maxSize = options.method === "PUT" && options.maxSize !== undefined ? blobSizeToBytes(options.maxSize) : undefined
  const link: SignedFsLink = {
    contentType,
    expires: String(Math.floor(Date.now() / 1000) + options.expiresIn),
    maxSize: maxSize === undefined ? "" : String(maxSize),
    method: options.method,
    pathname,
    store,
  }
  const query = new URLSearchParams({ expires: link.expires })
  if (link.contentType) query.set("content-type", link.contentType)
  if (link.maxSize) query.set("max-size", link.maxSize)
  query.set("signature", hex(await globalThis.crypto.subtle.sign("HMAC", await hmacKey(), payload(link))))
  const path = [store, ...pathname.split("/")].map(encodeURIComponent).join("/")
  return {
    headers: contentType ? { "Content-Type": contentType } : {},
    method: options.method,
    url: `${urlBaseUrl.replace(/\/+$/, "")}${blobSignedRoute}/${path}?${query}`,
  }
}

function reject(status: 403 | 405 | 413, diagnostic: ReturnType<typeof blobErrorDiagnostics.BLOB_R0041>, headers?: Record<string, string>): Response {
  return Response.json({ code: diagnostic.code, error: diagnostic.message, fix: diagnostic.fix }, { headers, status })
}

/**
 * Checks a request to the signed route. `path` is the raw path after the route: the store, then the pathname. Returns
 * the request to run, or the `Response` that rejects it. Web Crypto compares the signature in constant time.
 */
export async function verifyFsRequest(request: Request, path: string): Promise<VerifiedFsRequest | Response> {
  const method = request.method
  if (method !== "GET" && method !== "PUT") {
    return reject(405, blobErrorDiagnostics.BLOB_R0041({ message: `A signed Blob link accepts GET or PUT, not ${method}.` }), { Allow: "GET, PUT" })
  }
  const query = new URL(request.url).searchParams
  const separator = path.indexOf("/")
  const store = separator > 0 ? decode(path.slice(0, separator)) : undefined
  const pathname = separator > 0 ? decode(path.slice(separator + 1)) : undefined
  const link: SignedFsLink = {
    contentType: query.get("content-type") ?? "",
    expires: query.get("expires") ?? "",
    maxSize: query.get("max-size") ?? "",
    method,
    pathname: pathname ?? "",
    store: store ?? "",
  }
  const signature = query.get("signature") ?? ""
  const valid = store !== undefined && pathname !== undefined
    && /^\d+$/.test(link.expires) && /^\d*$/.test(link.maxSize) && /^[\da-f]{64}$/.test(signature)
    && await globalThis.crypto.subtle.verify("HMAC", await hmacKey(), Uint8Array.from(signature.match(/../g)!, byte => Number.parseInt(byte, 16)), payload(link))
  if (!valid) {
    return reject(403, blobErrorDiagnostics.BLOB_R0041({ message: "The signature of the Blob link does not match this request. A link works only for its method, store, pathname, and bound headers." }))
  }
  if (Number(link.expires) * 1000 <= Date.now()) {
    return reject(403, blobErrorDiagnostics.BLOB_R0042({ message: `The signed Blob link expired at ${new Date(Number(link.expires) * 1000).toISOString()}.` }))
  }
  const contentType = request.headers.get("content-type") ?? undefined
  if (link.contentType && contentType !== link.contentType) {
    return reject(403, blobErrorDiagnostics.BLOB_R0041({ message: `The signed Blob link binds \`Content-Type: ${link.contentType}\`. Send that header unchanged.` }))
  }
  const maxSize = link.maxSize ? Number(link.maxSize) : undefined
  if (maxSize !== undefined && Number(request.headers.get("content-length") ?? 0) > maxSize) return rejectTooLarge(maxSize)
  return { contentType, maxSize, method, path: path.slice(separator + 1), store: link.store }
}

/** The `Response` for a body that grew past the `maxSize` of its link while it streamed. */
export function rejectTooLarge(maxSize: number): Response {
  return reject(413, blobErrorDiagnostics.BLOB_R0043({ message: `The body is larger than the ${maxSize} bytes that the signed Blob link accepts.` }))
}
