import { createError, defineEventHandler, getRequestURL, setHeader, useStorage } from "#imports"

import type { EventHandler, EventHandlerRequest } from "h3"

/**
 * `/raw/<page>.md`: the agent copy that the build wrote. Static hosts serve the same files first; negotiated pages and
 * `.md` twins fetch them inside the server, so this route reads them from server assets.
 */
const handler: EventHandler<EventHandlerRequest, Promise<string>> = defineEventHandler(async (event) => {
  const path = decodeURIComponent(getRequestURL(event).pathname.replace(/^\/raw\//, ""))
  const markdown = path.endsWith(".md") ? await useStorage("assets:docs-raw").getItem<string>(path) : null
  if (markdown === null) throw createError({ statusCode: 404, statusMessage: "Page not found" })
  setHeader(event, "content-type", "text/markdown; charset=utf-8")
  return String(markdown)
})

export default handler
