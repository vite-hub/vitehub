import { createError, defineEventHandler, getRouterParam, useStorage } from "#imports"

import type { EventHandler, EventHandlerRequest } from "h3"
import manifest from "#docs/manifest"
import { createDocsParser } from "../../markdown.ts"
import { findDocsPage } from "../../navigation.ts"
import { docsPageResponse } from "../../page.ts"

import type { DocsDocument } from "../../markdown.ts"
import type { DocsPageResponse } from "../../page.ts"

const parse = createDocsParser()
const parsed = new Map<string, Promise<DocsDocument>>()

/** `/api/_docs/page/docs/kv.json` is the page at `/docs/kv`. The `.json` suffix lets static hosts store every page beside its folder. */
const handler: EventHandler<EventHandlerRequest, Promise<DocsPageResponse>> = defineEventHandler(async (event) => {
  const found = findDocsPage(manifest, `/${(getRouterParam(event, "_") ?? "").replace(/\.json$/, "")}`)
  if (!found) throw createError({ statusCode: 404, statusMessage: "Page not found" })
  const source = await useStorage("assets:docs").getItem<string>(found.page.file)
  if (source === null) throw createError({ statusCode: 404, statusMessage: "Page not found" })
  // A page parses once per server process. In development the content can change, so it always parses.
  const document = import.meta.dev ? parse(String(source)) : parsed.get(found.page.file) ?? parsed.set(found.page.file, parse(String(source))).get(found.page.file)!
  return docsPageResponse(manifest, found, await document)
})

export default handler
