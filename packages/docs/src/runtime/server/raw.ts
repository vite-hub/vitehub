import { HTTPError, defineHandler, getRouterParam } from "nitro/h3"

import type { EventHandler, EventHandlerRequest } from "nitro/h3"
import { readDocsFile } from "../files.ts"

/**
 * `/raw/<page>.md`: the agent copy that the build wrote. Static hosts serve the same files first; negotiated pages and
 * `.md` twins fetch them inside the server, so this route reads the packed copies.
 */
const handler: EventHandler<EventHandlerRequest, Promise<string>> = defineHandler(async (event) => {
  let path: string
  try {
    path = decodeURIComponent(getRouterParam(event, "_") ?? "")
  }
  catch {
    throw HTTPError.status(404, "Page not found")
  }
  const markdown = path.endsWith(".md") ? await readDocsFile("docs-raw", path) : null
  if (markdown === null) throw HTTPError.status(404, "Page not found")
  event.res.headers.set("content-type", "text/markdown; charset=utf-8")
  return markdown
})

export default handler
