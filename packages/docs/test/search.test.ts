import { readdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { defineContent } from "@vite-hub/content"
import { createSource, glob } from "@vite-hub/source"
import { beforeAll, describe, expect, it } from "vitest"

import { createDocsManifest } from "../src/manifest.ts"
import { docsMarkdown, docsSearchSections } from "../src/markdown.ts"
import { createDocsSearch, docsIndexedPages, docsUnindexedSearchSections } from "../src/navigation.ts"

import type { DocsSearchSection } from "../src/types.ts"

// The vitehub.dev content is the real index: about 2,800 records, most of them headings and error codes.
const contentDir = resolve(import.meta.dirname, "../../../docs/content")
const examplesDir = resolve(import.meta.dirname, "../../../docs/app/examples")
let search: ReturnType<typeof createDocsSearch>

beforeAll(async () => {
  const manifest = await createDocsManifest({ dir: contentDir, base: "/docs" })
  const examples = Object.fromEntries(await Promise.all(
    (await readdir(examplesDir)).filter(file => file.endsWith(".vue")).map(async file => [
      file.slice(0, -4),
      await readFile(resolve(examplesDir, file), "utf8"),
    ] as const),
  ))
  // As on the site, search reads each page through Content, parsed with the page parser config.
  const content = defineContent({
    route: false,
    live: false,
    markdown: docsMarkdown({ examples }),
    sources: { docs_0: () => createSource(glob({ include: ["**/*.md"] }), { rootDir: contentDir }) },
  })
  // One parse of the folder: a `glob()` Source reads every file again on each read of one page.
  const files = new Map((await content.instances.find(instance => instance.name === "docs_0")!.snapshot()).items.map(file => [file.meta.key, file]))
  const records: DocsSearchSection[] = []
  // As in the site search, a page that search engines skip, such as a generated diagnostic code page, has one record.
  for (const page of docsIndexedPages(manifest)) {
    const { nodes } = files.get(`docs_0/${page.file}`)!
    records.push(...docsSearchSections(page.path, page.sourceTitle, nodes))
  }
  records.push(...docsUnindexedSearchSections(manifest))
  search = createDocsSearch(records)
}, 60_000)

function ids(query: string, limit = 12) {
  return search(query, limit).map(record => record.id)
}

describe("docs search on the vitehub.dev content", () => {
  it("ranks the page named by the query first, then its section pages, before the error code headings", () => {
    const results = ids("kv")
    expect(results[0]).toBe("/docs/kv")
    expect(results.slice(0, 7)).toEqual(expect.arrayContaining([
      "/docs/kv/configure",
      "/docs/kv/hosts",
      "/docs/kv/server-api",
    ]))
    // The KV_* headings come after the pages, not instead of them.
    const firstErrorCode = results.findIndex(id => id.includes("#kv_"))
    expect(firstErrorCode === -1 || firstErrorCode > results.indexOf("/docs/kv/server-api")).toBe(true)
  })

  it("puts page titles before headings for a single word", () => {
    const results = search("queue", 12)
    expect(results[0]?.id).toBe("/docs/queue")
    const firstHeading = results.findIndex(record => record.level > 1)
    expect(results.slice(0, firstHeading).every(record => record.level === 1)).toBe(true)
    expect(results.slice(0, firstHeading).map(record => record.id)).toEqual(expect.arrayContaining(["/docs/queue/configure", "/docs/queue/server-api"]))
  })

  it("prefers a result whose titles hold every query word", () => {
    const [first] = search("schedule cron", 12)
    expect(first?.id).toBe("/docs/schedule/configure#run-a-schedule-on-another-cron-on-one-host")
    expect(ids("schedule cron")).toContain("/docs/schedule")
  })

  it("ranks the ChatGPT page above the error codes that contain the word", () => {
    const results = ids("chatgpt")
    expect(results[0]).toBe("/docs/connections/chatgpt")
    expect(results.slice(1, 7).every(id => id.startsWith("/docs/connections/limits-and-errors#connections_chatgpt_"))).toBe(true)
  })

  it("ranks Installation pages above Install headings", () => {
    const results = search("install", 12)
    const ids = results.map(record => record.id)
    // Other pages can mention installing, so check the order against headings, not exact positions.
    const firstHeading = results.findIndex(record => record.level > 1)
    expect(firstHeading).toBeGreaterThan(1)
    for (const page of ["/docs/getting-started/installation", "/docs/ui/installation"]) {
      expect(ids.indexOf(page)).toBeGreaterThanOrEqual(0)
      expect(ids.indexOf(page)).toBeLessThan(firstHeading)
    }
  })

  it("tolerates a typo, a swapped pair of letters, and an unfinished word", () => {
    expect(ids("schedle")[0]).toBe("/docs/schedule")
    expect(ids("chatgtp")[0]).toBe("/docs/connections/chatgpt")
    expect(ids("sched")[0]).toBe("/docs/schedule")
  })

  it("finds a page by its keywords, after the pages that have the word in their title", () => {
    const records: DocsSearchSection[] = [
      { id: "/annotate", title: "Annotate", titles: [], level: 1, content: "Marks on screenshots.", keywords: ["image annotation", "PR evidence"] },
      { id: "/evidence", title: "Evidence", titles: [], level: 1, content: "" },
      { id: "/guide#pr", title: "Open a PR", titles: ["Guide"], level: 2, content: "Write the evidence." },
    ]
    const local = createDocsSearch(records)
    expect(local("annotation", 5).map(record => record.id)).toEqual(["/annotate"])
    // A typo in a keyword still finds it, like a typo in a title.
    expect(local("evidnce", 5).map(record => record.id)).toEqual(["/evidence", "/annotate"])
    expect(local("pr evidence", 5).map(record => record.id)[0]).toBe("/annotate")
  })

  it("needs every word and returns nothing for an unknown word", () => {
    expect(ids("kv zzqqxxnotaword")).toEqual([])
    expect(ids("")).toEqual([])
    expect(ids("kv", 3)).toHaveLength(3)
  })
})
