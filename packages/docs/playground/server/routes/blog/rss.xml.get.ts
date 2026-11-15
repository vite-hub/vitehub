import { defineEventHandler } from "nuxt/server"
import { listPosts } from "../../utils/collections"
import { rss } from "../../utils/feed"

export default defineEventHandler(async event => rss(event, {
  title: "Lumen blog",
  path: "/blog",
  description: "Releases, engineering notes, and guides from the Lumen team.",
  items: (await listPosts()).map(post => ({ title: post.title, url: post.url, date: post.date, description: post.description })),
}))
