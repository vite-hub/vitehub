import assets from "#console-assets"

import { serveConsoleSkills } from "../../src/assets.ts"

export default {
  fetch: (request: Request): Response => serveConsoleSkills(request, assets),
}
