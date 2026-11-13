import { createHtmlRenderer } from "@comark/html"
import { defineHandler } from "h3"
import { contentHead } from "vite-hub/content"

import content from "../content"
import { escape, renderHead } from "../html"

const renderMarkdown = createHtmlRenderer()
const languages: Record<string, string> = { en: "English", es: "Español" }

// Every docs page, in every locale: /docs/guide in English and /es/docs/guide in Spanish. resolve() finds the document
// and the locale of the path. get() reads that locale, or the English version with `fallback: true` while the page has
// no translation. contentHead() gives `<html lang>`, the canonical link, and an hreflang link for each translation.
export default defineHandler(async (event) => {
  const url = new URL(event.req.url)
  const page = await content.resolve(url.pathname)
  if (page?.collection !== "docs") return new Response("Not found", { status: 404 })
  const docs = content.collection("docs")
  const document = await docs.get(page.id, { locale: page.locale })
  if (!document) return new Response("Not found", { status: 404 })
  const head = contentHead(document, { collection: docs, site: { url: url.origin, name: "Content playground" } })
  const switcher = (document.alternates ?? [])
    .map(alternate => `<a href="${escape(alternate.url)}" hreflang="${alternate.locale}">${escape(languages[alternate.locale] ?? alternate.locale)}</a>`)
    .join(" · ")
  return new Response(`<!doctype html><html lang="${escape(head.htmlAttrs?.lang ?? "en")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${renderHead(head)}</head>
<body style="font: 16px/1.6 system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1rem">
<nav>${switcher}</nav>
${document.fallback ? `<p role="note">This page is not translated yet. It shows the English version.</p>` : ""}
<article><h1>${escape(document.data.title)}</h1>${await renderMarkdown(document.body)}</article></body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  })
})
