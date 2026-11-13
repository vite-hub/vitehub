import { defineHandler } from "h3"

import type { EventHandlerWithFetch } from "h3"

import { blobSignedRoute, rejectTooLarge, verifyFsRequest } from "../internal/fs-sign.ts"
import { blob } from "./storage.ts"

type RouteRequest = Request & { context?: { params?: { _?: string } } }

// Nitro exposes its raw catch-all on the Request. A direct Fetchable call reads the path after the route.
function signedPath(request: RouteRequest): string {
  const param = request.context?.params?._
  if (param !== undefined) return param
  const { pathname } = new URL(request.url)
  return pathname.startsWith(`${blobSignedRoute}/`) ? pathname.slice(blobSignedRoute.length + 1) : ""
}

/**
 * Answers a link that `sign()` returned for an `fs` store, as a provider answers its own signed URL. A `GET` goes
 * through `serve()`, so it gets the same headers as the serve route. A `PUT` stores the body with `put()`.
 */
export async function handleSignedBlobRequest(request: Request): Promise<Response> {
  const verified = await verifyFsRequest(request, signedPath(request))
  if (verified instanceof Response) return verified
  const storage = blob.store(verified.store)
  if (verified.method === "GET") return storage.serve(request, verified.path)

  const { maxSize } = verified
  let tooLarge = false
  let size = 0
  // A body without `Content-Length` can still grow past `maxSize`. Stop reading it there.
  const body = request.body && maxSize !== undefined
    ? request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          size += chunk.byteLength
          if (size <= maxSize) return controller.enqueue(chunk)
          tooLarge = true
          controller.error(new RangeError("The body is larger than the signed Blob link accepts."))
        },
      }))
    : request.body ?? ""
  const [error, object] = await storage.put(verified.path, body, verified.contentType ? { contentType: verified.contentType } : {})
  if (tooLarge && maxSize !== undefined) return rejectTooLarge(maxSize)
  if (error) throw error
  return new Response(null, { headers: object.httpEtag ? { ETag: object.httpEtag } : {} })
}

/**
 * The route that Nitro mounts. It is an H3 handler, so it controls the response of its event in each mount, also
 * without Standard Context. A direct call can use its `fetch`.
 */
const signedRoute: EventHandlerWithFetch = defineHandler((event) => {
  // H3 adds the headers that middleware set before this route over the returned Response. A signed link expires,
  // so drop an earlier Cache-Control and keep the private policy of `serve()`.
  event.res.headers.delete("cache-control")
  return handleSignedBlobRequest(event.req)
})

export default signedRoute
