import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { parse as parseYaml } from "yaml"
import { afterEach, describe, expect, it } from "vitest"

import { defineContent } from "@vite-hub/content"

import { historyWorkspace } from "../../content/test/history-workspace.ts"
import { docsCollection } from "../src/collection.ts"
import { createDocsManifest } from "../src/manifest.ts"
import { docsManifestPages } from "../src/navigation.ts"
import { docsPageFields } from "../src/schema.ts"

const vitehubContent = resolve(import.meta.dirname, "../../../docs/content")
const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

/** Split a page file the way Content does: YAML frontmatter and the body after it. */
function pageFile(file: string): { data: Record<string, unknown>, body: string } {
  const text = readFileSync(file, "utf8")
  const match = /^---\n([\s\S]*?)\n---\n\n?/.exec(text)
  return { data: match ? parseYaml(match[1]!) : {}, body: match ? text.slice(match[0].length) : text }
}

describe("docsCollection", () => {
  it("reads the docs Markdown with the page fields and a label", () => {
    const collection = docsCollection()

    expect(collection.kind).toBe("documents")
    expect(collection.paths).toEqual(["content/**/*.md"])
    expect(Object.keys(collection.fields)).toEqual(Object.keys(docsPageFields))
    expect(collection.label).toBe("Docs")
    expect(collection.singularLabel).toBe("Page")
    expect(collection.titleField).toBe("title")
    expect(docsCollection({ path: "docs/content/**/*.md", label: "Pages" })).toMatchObject({ paths: ["docs/content/**/*.md"], label: "Pages" })
  })

  it("gives every page of vitehub.dev the URL that the manifest gives it", () => {
    const manifest = createDocsManifest({ dir: vitehubContent, base: "/docs" })
    const { url } = docsCollection()
    const pages = docsManifestPages(manifest)

    expect(pages.length).toBeGreaterThan(300)
    expect(url).toBeInstanceOf(Function)
    // A document id is its path below the collection folder, without `.md`.
    const mismatches = pages
      .map(page => ({ manifest: page.path, collection: url instanceof Function ? url({ id: page.file.replace(/\.md$/, ""), data: {} }) : undefined }))
      .filter(entry => entry.manifest !== entry.collection)
    expect(mismatches).toEqual([])
  })

  it("maps index pages to their folder", () => {
    const { url } = docsCollection()
    const urlOf = (id: string) => url instanceof Function ? url({ id, data: {} }) : undefined

    expect(urlOf("docs/kv/index")).toBe("/docs/kv")
    expect(urlOf("docs/kv/get-started")).toBe("/docs/kv/get-started")
    expect(urlOf("docs/index")).toBe("/docs")
    expect(urlOf("about")).toBe("/about")
    expect(urlOf("index")).toBe("/")
  })

  it("validates every page of vitehub.dev, dotted keys included", async () => {
    const manifest = createDocsManifest({ dir: vitehubContent, base: "/docs" })
    const issues: string[] = []
    for (const page of docsManifestPages(manifest)) {
      const { data } = pageFile(resolve(vitehubContent, page.file))
      for (const [key, value] of Object.entries(data)) {
        const field = Reflect.get(docsPageFields, key)
        if (!field) {
          issues.push(`${page.file}: ${key} has no field, so a Console save drops it`)
          continue
        }
        const result = await field["~standard"].validate(value)
        if (result.issues) issues.push(`${page.file}: ${key}: ${result.issues[0]?.message}`)
      }
    }
    expect(issues).toEqual([])
  })

  it("keeps dotted keys as written when the Console saves a read document", async () => {
    const workspace = await historyWorkspace(cleanup)
    const content = defineContent({ workspace, collections: { docs: docsCollection() }, authorize: () => true })
    const docs = content.collection("docs")
    const { data, body } = pageFile(resolve(vitehubContent, "docs/kv/get-started.md"))
    expect(Object.keys(data).filter(key => key.includes("."))).not.toEqual([])

    const seeded = await docs.save("docs/kv/get-started", { data, body }, { ifDigest: null })
    // The editor sends back the fields it read, with an edited body.
    const read = await docs.get("docs/kv/get-started", { ref: "draft" })
    expect(read?.issues).toBeUndefined()
    expect(read?.data).toEqual(data)
    expect(read?.url).toBe("/docs/kv/get-started")
    await docs.save("docs/kv/get-started", { data: read!.data, body: `${read!.body}\nEdited.\n` }, { ifDigest: seeded.digest })

    const stored = await docs.raw("docs/kv/get-started", { ref: "draft" })
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(stored!.text)![1]!
    for (const key of Object.keys(data).filter(key => key.includes("."))) expect(frontmatter).toContain(`\n${key}: `)
    expect(frontmatter).not.toMatch(/^navigation:/m)
    expect(await content.resolve("/docs/kv/get-started", { ref: "draft" })).toEqual({ collection: "docs", id: "docs/kv/get-started" })
  })
})
