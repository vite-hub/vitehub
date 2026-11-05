import { createError, defineEventHandler, getRouterParam, setHeader, useStorage } from "#imports"

import type { EventHandler, EventHandlerRequest } from "h3"
import { content } from "#docs/content"
import manifest from "#docs/manifest"
import parser from "#docs/parser"
import { createDocsParser } from "../../markdown.ts"
import { findDocsPage } from "../../navigation.ts"
import { docsPageResponse } from "../../page.ts"

import type { DocsDocument } from "../../markdown.ts"
import type { DocsPageResponse } from "../../page.ts"

const parse = createDocsParser(parser)
const parsed = new Map<string, Promise<DocsDocument>>()

/** `/api/_docs/page/docs/kv.json` is the page at `/docs/kv`. The `.json` suffix lets static hosts store every page beside its folder. */
const handler: EventHandler<EventHandlerRequest, Promise<DocsPageResponse>> = defineEventHandler(async (event) => {
  const path = `/${(getRouterParam(event, "_") ?? "").replace(/\.json$/, "")}`
  // A preview cookie or a Console preview frame reads the draft from the app's Content collection. Only those requests
  // load the code that reads drafts.
  if (content && (content.preview.active() || content.preview.frame())) {
    const { docsDraftResponse } = await import("../../draft.ts")
    const draft = await docsDraftResponse(content, manifest, path, parse)
    if (draft) {
      setHeader(event, "cache-control", "private, no-store")
      return draft
    }
  }
  const found = findDocsPage(manifest, path)
  if (!found) throw createError({ statusCode: 404, statusMessage: "Page not found" })
  const source = await useStorage("assets:docs").getItem<string>(found.page.file)
  if (source === null) throw createError({ statusCode: 404, statusMessage: "Page not found" })
  // A page parses once per server process. In development the content can change, so it always parses.
  const document = import.meta.dev ? parse(String(source)) : parsed.get(found.page.file) ?? parsed.set(found.page.file, parse(String(source))).get(found.page.file)!
  const credits = found.page.credits ? await parse(found.page.credits) : null
  return docsPageResponse(manifest, found, await document, credits)
})

export default handler
