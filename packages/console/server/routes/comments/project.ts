import { useDatabase } from "vite-hub/database"

import { serveCommentsProject } from "../../../src/comments-embed.ts"

export default {
  fetch: (request: Request): Promise<Response> => serveCommentsProject(request, useDatabase("default").db),
}
