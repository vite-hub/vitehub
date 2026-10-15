import { defineHandler, getRouterParam } from "h3"
import { contentHead } from "vite-hub/content"

import { content } from "../../content"

import type { ContentHead } from "vite-hub/content"

// A published post with head tags from contentHead(): the post's seo() values, then its own fields, then the settings.
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
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">${renderHead(head)}</head>
<body style="font: 15px/1.6 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem">
<p><a href="/">${escape(settings?.data.title ?? "Home")}</a></p><h1>${escape(post.data.title)}</h1><pre style="white-space: pre-wrap">${escape(post.body)}</pre></body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  })
})

/** Without a framework, render the tags that useHead() would add. */
function renderHead(head: ContentHead): string {
  const attributes = (tag: Record<string, string | undefined>) => Object.entries(tag).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}="${escape(value!)}"`).join(" ")
  return [
    head.title ? `<title>${escape(head.title)}</title>` : "",
    ...head.meta.map(meta => `<meta ${attributes({ ...meta })}>`),
    ...head.link.map(link => `<link ${attributes({ ...link })}>`),
    ...(head.script ?? []).map(script => `<script type="${script.type}">${script.innerHTML}</script>`),
  ].join("\n")
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)
}
