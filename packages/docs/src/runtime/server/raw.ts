import { HTTPError, defineHandler } from "nitro/h3"

import type { EventHandler, EventHandlerRequest } from "nitro/h3"
import { readDocsRawCopy } from "../content.ts"

/**
 * `/raw/<page>.md`: the agent copy of a page, the one that Content serves in `llms-full.txt` and the MCP server. The
 * build prerenders the copy of every page, so static hosts serve those files first. Negotiated pages and `.md` twins
 * fetch the copy inside the server, from this route.
 */
const handler: EventHandler<EventHandlerRequest, Promise<string>> = defineHandler(async (event) => {
  const markdown = await readDocsRawCopy(new URL(event.req.url).pathname)
  if (markdown === null) throw HTTPError.status(404, "Page not found")
  event.res.headers.set("content-type", "text/markdown; charset=utf-8")
  return markdown
})

export default handler
