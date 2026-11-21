import { publicUrl } from "../../site"

export interface FeedItem {
  title: string
  url: string
  date: string
  description: string
}

const escape = (value: string) => value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)

/** An RSS 2.0 feed of published documents. */
export function rss(feed: { title: string, path: string, description: string, items: FeedItem[] }): Response {
  const items = feed.items.map(item => [
    "<item>",
    `<title>${escape(item.title)}</title>`,
    `<link>${publicUrl}${item.url}</link>`,
    `<guid>${publicUrl}${item.url}</guid>`,
    `<pubDate>${new Date(item.date).toUTCString()}</pubDate>`,
    `<description>${escape(item.description)}</description>`,
    "</item>",
  ].join("")).join("\n")
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>${escape(feed.title)}</title>
<link>${publicUrl}${feed.path}</link>
<atom:link href="${publicUrl}${feed.path}/rss.xml" rel="self" type="application/rss+xml"/>
<description>${escape(feed.description)}</description>
${items}
</channel></rss>`
  return new Response(xml, { headers: { "content-type": "application/rss+xml; charset=utf-8" } })
}
