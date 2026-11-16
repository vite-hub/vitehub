import { createDocsParser } from "@vite-hub/docs/server"

import { mediaUrl } from "../../site"
import content from "../content"

import type { DocsDocument } from "@vite-hub/docs"

// The blog, changelog, and authors collections as the pages read them. Every read is `published`, except inside a
// Console preview, where Content reads the draft on screen.

export interface Author {
  id: string
  name: string
  role: string
  bio: string
  github?: string
}

export interface PostSummary {
  id: string
  url: string
  title: string
  description: string
  date: string
  tags: string[]
  authors: Author[]
  cover?: { light: string, dark: string }
}

export interface Release {
  id: string
  url: string
  version: string
  title: string
  date: string
  breaking: boolean
  document: DocsDocument
}

// The parser of the docs pages, so posts and releases get the same code blocks, callouts, and components.
const parse = createDocsParser()

export async function listAuthors(): Promise<Map<string, Author>> {
  const page = await content.collection("authors").list({ limit: 100 })
  return new Map(page.items.map(item => [item.id, { id: item.id, ...item.data }]))
}

// Illustrations come in a light and a dark file, such as `illustrations/guides-light.svg` and `-dark.svg`. A cover
// names the light file; the dark one is beside it.
function cover(pathname: string | undefined): PostSummary["cover"] {
  if (!pathname) return undefined
  const dark = pathname.replace(/-light(\.\w+)$/, "-dark$1")
  return { light: mediaUrl(pathname), dark: mediaUrl(dark) }
}

interface PostDocument {
  id: string
  url?: string | null
  data: { title: string, description: string, date: Date, authors: string[], tags: string[], cover?: { pathname: string } }
}

function summary(item: PostDocument, authors: Map<string, Author>): PostSummary {
  return {
    id: item.id,
    url: item.url ?? `/blog/${item.id}`,
    title: item.data.title,
    description: item.data.description,
    date: item.data.date.toISOString(),
    tags: item.data.tags,
    authors: item.data.authors.map(id => authors.get(id) ?? { id, name: id, role: "", bio: "" }),
    cover: cover(item.data.cover?.pathname),
  }
}

export async function listPosts(limit = 50): Promise<PostSummary[]> {
  const [page, authors] = await Promise.all([
    content.collection("blog").list({ sort: { field: "date", direction: "desc" }, limit }),
    listAuthors(),
  ])
  return page.items.map(item => summary(item, authors))
}

export async function getPost(id: string): Promise<(PostSummary & { document: DocsDocument }) | null> {
  const [post, authors] = await Promise.all([content.collection("blog").get(id), listAuthors()])
  return post ? { ...summary(post, authors), document: await parse(post.body) } : null
}

export async function listReleases(limit = 50): Promise<Release[]> {
  const page = await content.collection("changelog").list({ sort: { field: "date", direction: "desc" }, limit })
  // `list()` leaves out the body, and the changelog page shows every release in full.
  const releases = await Promise.all(page.items.map(item => content.collection("changelog").get(item.id)))
  return Promise.all(releases.filter(release => release !== null).map(async release => ({
    id: release.id,
    url: release.url ?? `/changelog/${release.id}`,
    version: release.data.version,
    title: release.data.title,
    date: release.data.date.toISOString(),
    breaking: release.data.breaking,
    document: await parse(release.body),
  })))
}
