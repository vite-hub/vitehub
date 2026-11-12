import { HTTPError, defineHandler, getRouterParam } from "nitro/h3"

import type { EventHandler, EventHandlerRequest } from "nitro/h3"
import { content } from "#docs/content"
import manifest from "#docs/manifest"
import { loadDocsDocument, parseDocsDocument } from "../documents.ts"
import { findDocsPage } from "../../navigation.ts"
import { docsPageResponse } from "../../page.ts"

import type { DocsPageResponse } from "../../page.ts"

/** `/api/_docs/page/docs/kv.json` is the page at `/docs/kv`. The `.json` suffix lets static hosts store every page beside its folder. */
const handler: EventHandler<EventHandlerRequest, Promise<DocsPageResponse>> = defineHandler(async (event) => {
  const path = `/${(getRouterParam(event, "_") ?? "").replace(/\.json$/, "")}`
  // A preview cookie or a Console preview frame reads the draft from the app's Content collection. Only those requests
  // load the code that reads drafts.
  if (content && (content.preview.active() || content.preview.frame())) {
    const { docsDraftResponse } = await import("../../draft.ts")
    const draft = await docsDraftResponse(content, manifest, path, parseDocsDocument)
    if (draft) {
      event.res.headers.set("cache-control", "private, no-store")
      return draft
    }
  }
  const found = findDocsPage(manifest, path)
  if (!found) throw HTTPError.status(404, "Page not found")
  const document = await loadDocsDocument(found.page.file, found.page.source)
  if (document === null) throw HTTPError.status(404, "Page not found")
  const credits = found.page.credits ? await parseDocsDocument(found.page.credits) : null
  return docsPageResponse(manifest, found, document, credits)
})

export default handler
