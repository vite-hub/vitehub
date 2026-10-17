import { defineHandler } from "h3"

import { content } from "../content"

// The public site lists published posts only. It has no edit button: editors open /_vitehub.
export default defineHandler(async () => {
  const [settings, { items }] = await Promise.all([
    content.collection("settings").get(),
    content.collection("posts").list({ sort: { field: "date", direction: "desc" } }),
  ])
  const title = settings?.data.title ?? "Content playground"
  const list = items.map(post => `<li><a href="${escape(post.url ?? "#")}"><strong>${escape(post.data.title)}</strong></a> <small>${post.data.date.toISOString().slice(0, 10)}</small></li>`).join("")
  return new Response(`<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>
<body style="font: 15px/1.6 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem">
<h1>${escape(title)}</h1>${settings?.data.description ? `<p>${escape(settings.data.description)}</p>` : ""}
<h2>Published posts</h2><ul>${list || "<li>Nothing published yet.</li>"}</ul>
<p><a href="/login">Sign in</a> · <a href="/_vitehub/content">Console</a></p></body>`, { headers: { "content-type": "text/html; charset=utf-8" } })
})

function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)
}
