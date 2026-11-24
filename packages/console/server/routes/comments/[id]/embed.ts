import { useDatabase } from "vite-hub/database"

import { serveCommentsEmbed } from "../../../../src/comments-embed.ts"

export default {
  fetch: (request: Request): Promise<Response> => serveCommentsEmbed(request, useDatabase("default").db),
}
