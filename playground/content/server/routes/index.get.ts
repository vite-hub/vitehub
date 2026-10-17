import { defineHandler } from "h3"

import { content } from "../content"

// The public site lists published posts only. It has no edit button: editors open /_vitehub.
export default defineHandler(async () => {
  const { items } = await content.collection("posts").list({ sort: { field: "date", direction: "desc" } })
  const list = items.map(post => `<li><strong>${escape(post.data.title)}</strong> <small>${post.data.date.toISOString().slice(0, 10)}</small></li>`).join("")
  return new Response(`<!doctype html><meta charset="utf-8"><title>Content playground</title>
<body style="font: 15px/1.6 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem">
<h1>Published posts</h1><ul>${list || "<li>Nothing published yet.</li>"}</ul>
<p><a href="/login">Sign in</a> · <a href="/_vitehub/content">Console</a></p></body>`, { headers: { "content-type": "text/html; charset=utf-8" } })
})

function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)
}
