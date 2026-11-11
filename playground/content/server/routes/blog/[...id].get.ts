import { createHtmlRenderer } from "@comark/html"
import { defineHandler, getRouterParam } from "h3"
import { contentHead } from "vite-hub/content"
import { contentField } from "vite-hub/content/client"

import content from "../../content"
import { attributes, escape, renderHead } from "../../html"

// The site's own components for the ones that posts declare in server/content.ts.
const renderMarkdown = createHtmlRenderer({
  components: {
    alert: async ([, attributes, ...children], { render }) =>
      `<aside class="alert alert-${escape(String(attributes.type ?? "info"))}">${await render(children)}</aside>`,
    badge: async ([, , ...children], { render }) => `<span class="badge">${await render(children)}</span>`,
  },
})

// A post with head tags from contentHead(): the post's seo() values, then its own fields, then the settings. Guests
// read the published post. The Console side browser renders the draft, and the edits on its screen, through the same
// `posts.get()`. `contentField()` marks what an editor can click in that preview.
export default defineHandler(async (event) => {
  const id = getRouterParam(event, "id") ?? ""
  const posts = content.collection("posts")
  const [settings, post] = await Promise.all([content.collection("settings").get(), posts.get(id)])
  if (!post) return new Response("Not found", { status: 404 })
  const head = contentHead(post, {
    collection: posts,
    site: { url: new URL(event.req.url).origin, name: settings?.data.title },
    defaults: { description: settings?.data.description, image: settings?.data.socialImage },
    jsonLd: true,
  })
  const field = (name: string) => attributes(contentField("posts", post.id, name))
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${renderHead(head)}
<style>
/* A plain site of its own, not the Console. It uses the system colors, so it follows the reader's light or dark mode. */
:root { color-scheme: light dark }
body { font: 16px/1.65 Georgia, "Times New Roman", serif; color: CanvasText; background: Canvas; max-width: 42rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem }
header a { font: 600 14px/1 system-ui, sans-serif; color: color-mix(in oklab, CanvasText 65%, Canvas); text-decoration: none }
h1 { font-size: 2.4rem; line-height: 1.15; margin: 1.5rem 0 .5rem }
.meta { font: 13px/1.4 system-ui, sans-serif; color: color-mix(in oklab, CanvasText 65%, Canvas); margin: 0 0 1.5rem }
.summary { font-size: 1.15rem; color: color-mix(in oklab, CanvasText 80%, Canvas); margin: 0 0 2rem }
img { max-width: 100%; height: auto; border-radius: 6px }
.alert { border-inline-start: 3px solid color-mix(in oklab, CanvasText 25%, Canvas); background: color-mix(in oklab, CanvasText 4%, Canvas); padding: .75rem 1rem; margin: 1.25rem 0 }
.badge { font: 600 12px/1 system-ui, sans-serif; background: color-mix(in oklab, CanvasText 8%, Canvas); border-radius: 999px; padding: .2rem .5rem }
</style></head>
<body>
<header><a href="/">${escape(settings?.data.title ?? "Home")}</a></header>
<article>
<h1 ${field("title")}>${escape(post.data.title)}</h1>
<p class="meta">${post.data.date.toISOString().slice(0, 10)} · <span ${field("category")}>${escape(post.data.category)}</span></p>
${post.data.summary ? `<p class="summary" ${field("summary")}>${escape(post.data.summary)}</p>` : ""}
<div ${field("body")}>${await renderMarkdown(post.body)}</div>
</article></body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  })
})
