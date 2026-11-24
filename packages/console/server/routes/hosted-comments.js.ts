import assets from "#console-assets"

import { serveHostedComments } from "../../src/assets.ts"

export default {
  fetch: (request: Request): Response => serveHostedComments(request, assets),
}
