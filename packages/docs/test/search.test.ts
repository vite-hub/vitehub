import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { beforeAll, describe, expect, it } from "vitest"

import { createDocsManifest } from "../src/manifest.ts"
import { createDocsParser, docsSearchSections } from "../src/markdown.ts"
import { createDocsSearch, docsManifestPages } from "../src/navigation.ts"

import type { DocsSearchSection } from "../src/types.ts"

// The vitehub.dev content is the real index: about 2,800 records, most of them headings and error codes.
const contentDir = resolve(import.meta.dirname, "../../../docs/content")
let search: ReturnType<typeof createDocsSearch>

beforeAll(async () => {
  const manifest = createDocsManifest({ dir: contentDir, base: "/docs" })
  const parse = createDocsParser()
  const records: DocsSearchSection[] = []
  for (const page of docsManifestPages(manifest)) {
    const { nodes } = await parse(await readFile(resolve(contentDir, page.file), "utf8"))
    records.push(...docsSearchSections(page.path, page.sourceTitle, nodes))
  }
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
    expect(results.slice(0, 2).map(record => record.id)).toEqual(["/docs/getting-started/installation", "/docs/ui/installation"])
    expect(results[2]?.level).toBeGreaterThan(1)
  })

  it("tolerates a typo, a swapped pair of letters, and an unfinished word", () => {
    expect(ids("schedle")[0]).toBe("/docs/schedule")
    expect(ids("chatgtp")[0]).toBe("/docs/connections/chatgpt")
    expect(ids("sched")[0]).toBe("/docs/schedule")
  })

  it("needs every word and returns nothing for an unknown word", () => {
    expect(ids("kv zzqqxxnotaword")).toEqual([])
    expect(ids("")).toEqual([])
    expect(ids("kv", 3)).toHaveLength(3)
  })
})
