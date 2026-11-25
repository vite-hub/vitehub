import assets from "#console-assets"

import { serveConsolePageAsset } from "../../../src/assets.ts"

export default {
  fetch: (request: Request): Response => serveConsolePageAsset(request, assets),
}
