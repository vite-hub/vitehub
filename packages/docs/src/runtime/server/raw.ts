import { HTTPError, defineHandler } from "nitro/h3"

import type { EventHandler, EventHandlerRequest } from "nitro/h3"
import { docsContent } from "../content.ts"

/**
 * `/raw/<page>.md`: the agent copy of a page, from Content. The build prerenders the copy of every page, so static
 * hosts serve those files first. Negotiated pages and `.md` twins fetch the copy inside the server, from this route.
 */
const handler: EventHandler<EventHandlerRequest, Promise<string>> = defineHandler(async (event) => {
  let path: string
  try {
    path = decodeURIComponent(event.url.pathname)
  }
  catch {
    throw HTTPError.status(404, "Page not found")
  }
  // Nitro routes below the app base, so the copy is the part from `/raw/` on.
  const index = path.indexOf("/raw/")
  const markdown = index < 0 ? null : await docsContent().markdown(path.slice(index))
  if (markdown === null) throw HTTPError.status(404, "Page not found")
  event.res.headers.set("content-type", "text/markdown; charset=utf-8")
  return markdown
})

export default handler
