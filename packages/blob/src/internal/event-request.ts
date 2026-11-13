import { getStandardContext, installStandardContext } from "@vite-hub/runtime/internal/h3"

import type { BlobUploadEvent } from "../types.ts"

/** The Request of an upload event. A `nuxt/server` event has no `~standard` in its type, and a Request has no `req`. */
export function eventRequest(event: BlobUploadEvent): Request {
  if ("req" in event) installStandardContext(event)
  return getStandardContext(event).req
}
